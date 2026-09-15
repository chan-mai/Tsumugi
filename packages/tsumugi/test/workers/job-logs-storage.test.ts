import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { LOG_KEEP, LOG_MAX_CHARS, LOG_MIN_INTERVAL_MS, type JobLogEntry } from '../../src/core/log.js';
import type { DispatchMessage, EnqueueInput, TsumugiJobShard } from '../../src/do/job-shard.js';
import type { JobRepo } from '../../src/do/repo.js';
import { applySchema, SCHEMA } from '../../src/do/schema.js';
import { jobLog } from '../../src/do/tables.js';
import { project } from '../../src/projection/projector.js';

const T0 = 2_400_000_000_000;
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const shard = (name: string) => env.JOB_SHARD.get(env.JOB_SHARD.idFromName(name));

async function install(name: string, now: number, sent: DispatchMessage[] = []): Promise<void> {
	await runInDurableObject(shard(name), (instance) => {
		(instance as any).clock = { now: () => now };
		(instance as any).env.TSUMUGI_QUEUE = {
			send: async (body: DispatchMessage) => void sent.push(body),
			sendBatch: async (batch: Iterable<{ body: DispatchMessage }>) => {
				for (const message of batch) sent.push(message.body);
			},
		};
	});
}

async function queued(name: string, input: Partial<EnqueueInput> = {}) {
	const sent: DispatchMessage[] = [];
	await install(name, T0, sent);
	const jobId = await shard(name).enqueue({ binding: name.split('#')[0]!, payload: {}, ...input });
	await runDurableObjectAlarm(shard(name));
	return { jobId, sent };
}

const logsOf = (name: string, id: string) => runInDurableObject(shard(name), (instance) => ((instance as any).repo as JobRepo).logsOf(id));

const writesOf = (name: string) => runInDurableObject(shard(name), (instance) => ((instance as any).repo as JobRepo).writes);

const readModel = (id: string) =>
	env.TSUMUGI_DB.prepare('SELECT logs, traceparent, state FROM job WHERE id = ?')
		.bind(id)
		.first<{ logs: string | null; traceparent: string | null; state: string }>();

describe('ジョブログの保存と投影', () => {
	it('実行中のログを試行番号とサーバー時刻で保存しD1へ投影する', async () => {
		const name = 'LOGSTORE1#0';
		const { jobId, sent } = await queued(name, { traceparent: TRACEPARENT });
		expect(sent[0]?.traceparent).toBe(TRACEPARENT);
		expect(await shard(name).log(jobId, 1, '開始')).toBe(true);
		const expected: JobLogEntry[] = [{ attempt: 1, timestamp: T0, message: '開始' }];
		expect(await logsOf(name, jobId)).toEqual(expected);
		await runDurableObjectAlarm(shard(name));
		expect(await readModel(jobId)).toEqual({ logs: JSON.stringify(expected), traceparent: TRACEPARENT, state: 'QUEUED' });
	});

	it('本文の長さと最短間隔を制限する', async () => {
		const name = 'LOGSTORE2#0';
		const { jobId } = await queued(name);
		await shard(name).log(jobId, 1, 'x'.repeat(LOG_MAX_CHARS + 1));
		const before = await writesOf(name);
		await install(name, T0 + LOG_MIN_INTERVAL_MS - 1);
		expect(await shard(name).log(jobId, 1, '間隔不足')).toBe(true);
		expect(await writesOf(name)).toBe(before);
		await install(name, T0 + LOG_MIN_INTERVAL_MS);
		expect(await shard(name).log(jobId, 1, '次の記録')).toBe(true);
		expect(await logsOf(name, jobId)).toEqual([
			{ attempt: 1, timestamp: T0, message: 'x'.repeat(LOG_MAX_CHARS) },
			{ attempt: 1, timestamp: T0 + LOG_MIN_INTERVAL_MS, message: '次の記録' },
		]);
	});

	it('再試行のログとtraceparentを保持し古い試行の記録を除外する', async () => {
		const name = 'LOGSTORE3#0';
		const { jobId } = await queued(name, { traceparent: TRACEPARENT, maxAttempts: 1 });
		await shard(name).log(jobId, 1, '初回');
		await shard(name).report(jobId, { ok: false, error: 'failure' });
		expect(await shard(name).log(jobId, 1, '終了後')).toBe(false);
		await install(name, T0 + LOG_MIN_INTERVAL_MS);
		await shard(name).retry(jobId);
		const sent: DispatchMessage[] = [];
		await install(name, T0 + LOG_MIN_INTERVAL_MS, sent);
		await runDurableObjectAlarm(shard(name));
		expect(sent[0]).toMatchObject({ attempt: 2, traceparent: TRACEPARENT });
		expect(await shard(name).log(jobId, 1, '古い試行')).toBe(false);
		expect(await shard(name).log(jobId, 2, '再試行')).toBe(true);
		expect(await logsOf(name, jobId)).toEqual([
			{ attempt: 1, timestamp: T0, message: '初回' },
			{ attempt: 2, timestamp: T0 + LOG_MIN_INTERVAL_MS, message: '再試行' },
		]);
	});

	it('再試行をまたいで最新20件を保持する', async () => {
		const name = 'LOGSTORE4#0';
		const { jobId } = await queued(name, { maxAttempts: 1 });
		for (let index = 0; index < LOG_KEEP; index++) {
			await install(name, T0 + index * LOG_MIN_INTERVAL_MS);
			expect(await shard(name).log(jobId, 1, `log-${index}`)).toBe(true);
		}
		await shard(name).report(jobId, { ok: false, error: 'failure' });
		await install(name, T0 + LOG_KEEP * LOG_MIN_INTERVAL_MS);
		await shard(name).retry(jobId);
		await runDurableObjectAlarm(shard(name));
		for (let index = 0; index < 5; index++) {
			await install(name, T0 + (LOG_KEEP + index) * LOG_MIN_INTERVAL_MS);
			expect(await shard(name).log(jobId, 2, `retry-${index}`)).toBe(true);
		}
		const logs = await logsOf(name, jobId);
		expect(logs).toHaveLength(LOG_KEEP);
		expect(logs[0]).toMatchObject({ attempt: 1, message: 'log-5' });
		expect(logs.at(-1)).toMatchObject({ attempt: 2, message: 'retry-4' });
		await runDurableObjectAlarm(shard(name));
		expect(JSON.parse((await readModel(jobId))!.logs!)).toEqual(logs);
	});

	it('未実行と終了済みのジョブにはログを追加しない', async () => {
		const name = 'LOGSTORE5#0';
		await install(name, T0);
		const jobId = await shard(name).enqueue({ binding: 'LOGSTORE5', payload: {} });
		expect(await shard(name).log(jobId, 1, '未実行')).toBe(false);
		expect(await shard(name).log('missing', 1, '不明')).toBe(false);
		await runDurableObjectAlarm(shard(name));
		expect(await shard(name).log(jobId, 0, '無効な試行')).toBe(false);
		await shard(name).report(jobId, { ok: true });
		expect(await shard(name).log(jobId, 1, '完了後')).toBe(false);
		expect(await logsOf(name, jobId)).toEqual([]);
	});

	it('終端ジョブの削除後もD1にログを保持する', async () => {
		const name = 'LOGSTORE6#0';
		const { jobId } = await queued(name);
		await shard(name).configure({ sweepAfterMs: 1_000 });
		await shard(name).log(jobId, 1, '完了前');
		await shard(name).report(jobId, { ok: true });
		await install(name, T0 + 2_000);
		await runDurableObjectAlarm(shard(name));
		expect(await shard(name).stateOf(jobId)).toBeNull();
		expect(await logsOf(name, jobId)).toEqual([]);
		expect(JSON.parse((await readModel(jobId))!.logs!)).toEqual([{ attempt: 1, timestamp: T0, message: '完了前' }]);
	});

	it('既存DOへ列とログ表を追加する', async () => {
		const stub = shard('LOGSTORE7#0');
		const actual = await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec('DROP TABLE IF EXISTS job');
			state.storage.sql.exec('DROP TABLE IF EXISTS job_log');
			state.storage.sql.exec(SCHEMA[0].replace('\n\t\ttraceparent TEXT,', ''));
			state.storage.sql
				.exec(`INSERT INTO job (id, binding, state, max_attempts, guarantee, timeout_ms, backoff, run_after, created_at, updated_at, payload)
				VALUES ('legacy', 'LOGSTORE7', 'SCHEDULED', 1, 'at-least-once', 60000, '{}', 0, 0, 0, '{}')`);
			const columns = (table: string) => state.storage.sql.exec<{ name: string }>('SELECT name FROM pragma_table_info(?)', table).toArray();
			const before = columns('job');
			applySchema(state.storage.sql);
			return {
				before,
				job: columns('job'),
				log: columns('job_log'),
				row: state.storage.sql.exec<{ id: string; traceparent: string | null }>('SELECT id, traceparent FROM job').one(),
			};
		});
		expect(actual.before.map((column) => column.name)).not.toContain('traceparent');
		expect(actual.job.map((column) => column.name)).toContain('traceparent');
		expect(actual.row).toEqual({ id: 'legacy', traceparent: null });
		expect(actual.log.map((column) => column.name).sort()).toEqual(
			getTableConfig(jobLog)
				.columns.map((column) => column.name)
				.sort(),
		);
	});

	it('旧スナップショットの投影で追加列をnullにする', async () => {
		const name = 'LOGSTORE8#0';
		const { jobId } = await queued(name);
		const snapshot = await runInDurableObject(shard(name), (instance) => {
			const { traceparent: _traceparent, ...row } = ((instance as any).repo as JobRepo).find(jobId)!;
			return row;
		});
		await project(env.TSUMUGI_DB, [{ seq: 100, job_id: jobId, snapshot: JSON.stringify(snapshot) }]);
		expect(await readModel(jobId)).toEqual({ logs: null, traceparent: null, state: 'QUEUED' });
	});

	it('無効なtraceparentを含む一括投入ではジョブを作成しない', async () => {
		const name = 'LOGSTORE9#0';
		await install(name, T0);
		const error = await runInDurableObject(shard(name), async (instance) => {
			try {
				await (instance as TsumugiJobShard).enqueueMany([
					{ binding: 'LOGSTORE9', payload: {}, traceparent: TRACEPARENT },
					{ binding: 'LOGSTORE9', payload: {}, traceparent: 'invalid' },
				]);
				return null;
			} catch (error) {
				return (error as Error).message;
			}
		});
		expect(error).toContain('traceparent');
		const count = await runInDurableObject(shard(name), (instance) => ((instance as any).repo as JobRepo).countJobs());
		expect(count).toBe(0);
	});
});
