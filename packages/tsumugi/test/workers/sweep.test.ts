import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { DispatchMessage } from '../../src/do/job-shard.js';
import { sweepReadModel } from '../../src/projection/sweep.js';

const T0 = 2_400_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function captureQueue() {
	const sent: DispatchMessage[] = [];
	return {
		sent,
		queue: {
			send: async (body: DispatchMessage) => void sent.push(body),
			sendBatch: async (batch: Iterable<{ body: DispatchMessage }>) => {
				for (const m of batch) sent.push(m.body);
			},
		},
	};
}

const shard = (name: string) => env.JOB_SHARD.get(env.JOB_SHARD.idFromName(name));

async function install(name: string, now: number, queue: unknown) {
	await runInDurableObject(shard(name), (instance) => {
		(instance as any).clock = { now: () => now };
		(instance as any).env.TSUMUGI_QUEUE = queue;
	});
}

const countJobs = (name: string) => runInDurableObject(shard(name), (instance) => (instance as any).repo.countJobs() as number);
const stateOf = (name: string, id: string) =>
	runInDurableObject(shard(name), (instance) => (instance as any).repo.find(id)?.state as string | undefined);

describe('DOの終端ジョブ削除', () => {
	it('保持期間を過ぎた終端ジョブを削除する', async () => {
		const { sent, queue } = captureQueue();
		const RETENTION = 10 * 60 * 1000;
		await install('SWEEP#0', T0, queue);
		await shard('SWEEP#0').configure({ sweepAfterMs: RETENTION });

		const jobId = await shard('SWEEP#0').enqueue({ binding: 'SWEEP', payload: {} });
		await runDurableObjectAlarm(shard('SWEEP#0'));
		await shard('SWEEP#0').report(sent[0]!.jobId, { ok: true });
		expect(await stateOf('SWEEP#0', jobId)).toBe('COMPLETED');

		await install('SWEEP#0', T0 + 5 * 60 * 1000, queue);
		await runDurableObjectAlarm(shard('SWEEP#0'));
		expect(await stateOf('SWEEP#0', jobId)).toBe('COMPLETED');

		await install('SWEEP#0', T0 + RETENTION + 60_000, queue);
		await runDurableObjectAlarm(shard('SWEEP#0'));
		expect(await stateOf('SWEEP#0', jobId)).toBeUndefined();
	});

	it('削除の間隔より短い間ではDELETEを実行しない', async () => {
		// tickは完了報告ごとに実行, 対象なしのDELETEも書き込み増加
		const { queue } = captureQueue();
		await install('SWEEP5#0', T0, queue);
		await shard('SWEEP5#0').enqueue({ binding: 'SWEEP5', payload: {} });
		await runDurableObjectAlarm(shard('SWEEP5#0'));

		const before = await runInDurableObject(shard('SWEEP5#0'), (i) => (i as any).repo.writes as number);
		await install('SWEEP5#0', T0 + 1_000, queue);
		await runDurableObjectAlarm(shard('SWEEP5#0'));
		const after = await runInDurableObject(shard('SWEEP5#0'), (i) => (i as any).repo.writes as number);

		expect(after - before).toBe(0);
	});

	it('稼働中のジョブは削除しない', async () => {
		const { queue } = captureQueue();
		await install('SWEEP2#0', T0, queue);
		await shard('SWEEP2#0').configure({ sweepAfterMs: 1 });

		const jobId = await shard('SWEEP2#0').enqueue({ binding: 'SWEEP2', payload: {}, timeoutMs: 10 ** 12 });
		await runDurableObjectAlarm(shard('SWEEP2#0'));

		await install('SWEEP2#0', T0 + 10 ** 9, queue);
		await runDurableObjectAlarm(shard('SWEEP2#0'));
		expect(await stateOf('SWEEP2#0', jobId)).toBe('QUEUED');
	});

	it('期限切れの重複排除キーを削除する', async () => {
		const { queue } = captureQueue();
		await install('SWEEP3#0', T0, queue);
		const first = await shard('SWEEP3#0').enqueue({ binding: 'SWEEP3', payload: {}, uniqueKey: 'k', uniqueForMs: 1_000 });

		await install('SWEEP3#0', T0 + 2_000, queue);
		await runDurableObjectAlarm(shard('SWEEP3#0'));

		await install('SWEEP3#0', T0 + 3_000, queue);
		const second = await shard('SWEEP3#0').enqueue({ binding: 'SWEEP3', payload: {}, uniqueKey: 'k', uniqueForMs: 1_000 });
		expect(second).not.toBe(first);
	});

	it('削除しなければ残り続ける', async () => {
		const { queue } = captureQueue();
		await install('SWEEP4#0', T0, queue);
		await shard('SWEEP4#0').configure({ policy: { concurrency: 0 } });

		await shard('SWEEP4#0').enqueueMany(Array.from({ length: 5 }, () => ({ binding: 'SWEEP4', payload: {} })));
		expect(await countJobs('SWEEP4#0')).toBe(5);
	});
});

describe('失敗ジョブは別の保持期間を持つ(ADR-0027)', () => {
	async function failJob(name: string, binding: string, now: number, queue: { sent: DispatchMessage[]; queue: unknown }) {
		await install(name, now, queue.queue);
		const jobId = await shard(name).enqueue({ binding, payload: {}, maxAttempts: 1 });
		await runDurableObjectAlarm(shard(name));
		await shard(name).report(queue.sent[queue.sent.length - 1]!.jobId, { ok: false });
		return jobId;
	}

	it('済んだジョブが消えても失敗ジョブは残る', async () => {
		const q = captureQueue();
		await install('SPLIT#0', T0, q.queue);
		await shard('SPLIT#0').configure({ sweepAfterMs: 60_000, failedRetentionMs: 7 * 24 * 60 * 60 * 1000 });

		const failed = await failJob('SPLIT#0', 'SPLIT', T0, q);
		const done = await shard('SPLIT#0').enqueue({ binding: 'SPLIT', payload: {} });
		await runDurableObjectAlarm(shard('SPLIT#0'));
		await shard('SPLIT#0').report(done, { ok: true });

		expect(await stateOf('SPLIT#0', failed)).toBe('FAILED');
		expect(await stateOf('SPLIT#0', done)).toBe('COMPLETED');

		await install('SPLIT#0', T0 + 120_000, q.queue);
		await runDurableObjectAlarm(shard('SPLIT#0'));

		expect(await stateOf('SPLIT#0', done)).toBeUndefined();
		expect(await stateOf('SPLIT#0', failed)).toBe('FAILED');
	});

	it('失敗側の保持を過ぎれば落ちる', async () => {
		const q = captureQueue();
		await install('SPLIT2#0', T0, q.queue);
		await shard('SPLIT2#0').configure({ sweepAfterMs: 1_000, failedRetentionMs: 60_000 });
		const failed = await failJob('SPLIT2#0', 'SPLIT2', T0, q);

		await install('SPLIT2#0', T0 + 120_000, q.queue);
		await runDurableObjectAlarm(shard('SPLIT2#0'));
		expect(await stateOf('SPLIT2#0', failed)).toBeUndefined();
	});

	it('既定では失敗ジョブが5分では消えない', async () => {
		// 既定が短いと一覧表示中でも再開不能なジョブが発生
		const q = captureQueue();
		const failed = await failJob('SPLIT3#0', 'SPLIT3', T0, q);

		await install('SPLIT3#0', T0 + 60 * 60 * 1000, q.queue);
		await runDurableObjectAlarm(shard('SPLIT3#0'));
		expect(await stateOf('SPLIT3#0', failed)).toBe('FAILED');
	});

	it('次に対象が出る時刻へalarmを設定する', async () => {
		// 固定間隔起動では失敗ジョブ残存中に無用な書き込みが累積
		const q = captureQueue();
		await install('SPLIT4#0', T0, q.queue);
		await shard('SPLIT4#0').configure({ sweepAfterMs: 1_000, failedRetentionMs: 60 * 60 * 1000 });
		await failJob('SPLIT4#0', 'SPLIT4', T0, q);

		await install('SPLIT4#0', T0 + 10_000, q.queue);
		await runDurableObjectAlarm(shard('SPLIT4#0'));

		const alarm = await runInDurableObject(shard('SPLIT4#0'), (_i, state) => state.storage.getAlarm());
		expect(alarm).toBeGreaterThan(T0 + 30 * 60 * 1000);
	});
});

describe('状態を変える操作はalarmを設定する', () => {
	// 未設定時はアウトボックス滞留、200応答直後の読み取りモデルが古いまま
	const alarmOf = (name: string) => runInDurableObject(shard(name), (_i, state) => state.storage.getAlarm());

	it('cancelがalarmを設定する', async () => {
		const { queue } = captureQueue();
		await install('CANCEL#0', T0, queue);

		const jobId = await shard('CANCEL#0').enqueue({ binding: 'CANCEL', payload: {}, delayMs: 60 * 60 * 1000 });
		// 投入直後のalarmは投影用now, 1回実行後は実行予定時刻
		await runDurableObjectAlarm(shard('CANCEL#0'));
		expect(await alarmOf('CANCEL#0')).toBe(T0 + 60 * 60 * 1000);

		expect(await shard('CANCEL#0').cancel(jobId)).toEqual({ ok: true });
		expect(await alarmOf('CANCEL#0')).toBe(T0);
	});

	it('取り消せなければalarmを動かさない', async () => {
		const { sent, queue } = captureQueue();
		await install('CANCEL2#0', T0, queue);

		const jobId = await shard('CANCEL2#0').enqueue({ binding: 'CANCEL2', payload: {} });
		await runDurableObjectAlarm(shard('CANCEL2#0'));
		await shard('CANCEL2#0').report(sent[0]!.jobId, { ok: true });

		const before = await alarmOf('CANCEL2#0');
		expect(await shard('CANCEL2#0').cancel(jobId)).toEqual({ ok: false, reason: 'invalid-state' });
		expect(await alarmOf('CANCEL2#0')).toBe(before);
	});
});

describe('読み取りモデルの終端ジョブ削除', () => {
	const insert = (id: string, state: string, updatedAt: number) =>
		env.TSUMUGI_DB.prepare(
			`INSERT INTO job (id, seq, binding, state, priority, attempts, max_attempts, guarantee, created_at, updated_at, payload)
			 VALUES (?, 1, 'RM', ?, 0, 1, 3, 'at-least-once', ?, ?, '{}')`,
		)
			.bind(id, state, updatedAt, updatedAt)
			.run();

	const exists = async (id: string) => (await env.TSUMUGI_DB.prepare('SELECT id FROM job WHERE id = ?').bind(id).first()) !== null;

	it('保持期間を過ぎた終端ジョブを削除する', async () => {
		await insert('RM#0:old', 'COMPLETED', T0 - 8 * DAY);
		await insert('RM#0:recent', 'COMPLETED', T0 - 1 * DAY);

		const removed = await sweepReadModel(env.TSUMUGI_DB, T0, { olderThanMs: 7 * DAY });

		expect(removed).toBeGreaterThanOrEqual(1);
		expect(await exists('RM#0:old')).toBe(false);
		expect(await exists('RM#0:recent')).toBe(true);
	});

	it('稼働中のジョブは古くても削除しない', async () => {
		await insert('RM#0:stuck', 'RUNNING', T0 - 100 * DAY);
		await sweepReadModel(env.TSUMUGI_DB, T0, { olderThanMs: 7 * DAY });
		expect(await exists('RM#0:stuck')).toBe(true);
	});

	it('1回で消す件数に上限がある', async () => {
		for (let i = 0; i < 5; i++) await insert(`RM#0:bulk${i}`, 'FAILED', T0 - 30 * DAY);
		const removed = await sweepReadModel(env.TSUMUGI_DB, T0, { olderThanMs: 7 * DAY, limit: 2 });
		expect(removed).toBe(2);
	});
});

describe('読み取りモデルの終端run削除', () => {
	const insertRun = async (id: string, state: string, updatedAt: number) => {
		await env.TSUMUGI_DB.prepare(
			`INSERT INTO run (id, seq, flow, state, input, node_total, node_done, node_failed, created_at, updated_at)
			 VALUES (?, 1, 'F', ?, '{}', 1, 1, 0, ?, ?)`,
		)
			.bind(id, state, updatedAt, updatedAt)
			.run();
		await env.TSUMUGI_DB.prepare(
			`INSERT INTO run_node (run_id, node_id, seq, binding, state, container, origin, after, position, created_at, updated_at)
			 VALUES (?, 'a', 1, 'B', ?, 0, 'static', '[]', 0, ?, ?)`,
		)
			.bind(id, state, updatedAt, updatedAt)
			.run();
	};
	const count = async (table: 'run' | 'run_node', column: 'id' | 'run_id', id: string) =>
		(await env.TSUMUGI_DB.prepare(`SELECT count(*) AS c FROM ${table} WHERE ${column} = ?`).bind(id).first<{ c: number }>())!.c;

	it('保持期間を過ぎた終端runとそのノードを削除する', async () => {
		await insertRun('F:old', 'COMPLETED', T0 - 8 * DAY);
		await insertRun('F:recent', 'FAILED', T0 - 1 * DAY);
		await insertRun('F:running', 'RUNNING', T0 - 100 * DAY);

		await sweepReadModel(env.TSUMUGI_DB, T0, { olderThanMs: 7 * DAY });

		expect([await count('run', 'id', 'F:old'), await count('run_node', 'run_id', 'F:old')]).toEqual([0, 0]);
		expect([await count('run', 'id', 'F:recent'), await count('run_node', 'run_id', 'F:recent')]).toEqual([1, 1]);
		expect([await count('run', 'id', 'F:running'), await count('run_node', 'run_id', 'F:running')]).toEqual([1, 1]);
	});
});
