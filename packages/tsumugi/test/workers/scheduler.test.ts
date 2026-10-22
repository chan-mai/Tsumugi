import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { RunRow } from '../../src/do/run-schema.js';
import type { ScheduleRow } from '../../src/do/scheduler-schema.js';
import type { ScheduleView } from '../../src/do/scheduler.js';

// schedule定義はexamples/basic, Scheduler DOが参照(ADR-0040)
// poll-namesは固定間隔skip, ping-helloはoverlap, nightlyはcronでflow起動

const POLL_MS = 5 * 60 * 1000;
const PING_MS = 60_000;

// 過去予定は固定時計と無関係にalarm即発火、未来に配置
// ジョブIDは予定時刻から確定、テストごとに日を分けて衝突回避
const day = (n: number) => Date.UTC(2046, 0, 5 + n, 12, 0, 0);

// 起点日の次の東京3時(cron `0 3 * * *`)
const nightlyOf = (base: number) => base + 6 * 60 * 60 * 1000;

// 使用メソッドのみ宣言, DO型直接参照でTS2589発生
interface SchedulerFace extends Rpc.DurableObjectBranded {
	sync(): Promise<void>;
	list(): Promise<unknown[]>;
	setPaused(name: string, paused: boolean): Promise<unknown>;
	trigger(name: string): Promise<unknown>;
}

const namespace = env.SCHEDULER as unknown as DurableObjectNamespace<SchedulerFace>;
const inside = () => namespace.get(namespace.idFromName('scheduler'));
const callSync = () => inside().sync();
const callList = async () => (await inside().list()) as ScheduleView[];
const shard = (binding: string) => env.JOB_SHARD.get(env.JOB_SHARD.idFromName(`${binding}#0`));

const rowsOf = () => runInDurableObject(inside(), (instance) => (instance as any).repo.rows() as ScheduleRow[]);
const rowOf = async (name: string) => (await rowsOf()).find((row) => row.name === name);
const alarmOf = () => runInDurableObject(inside(), (instance) => (instance as any).ctx.storage.getAlarm() as number | null);

// 実キューではconsumer実行でジョブ終端化、skip判定が変化
const BINDINGS = ['ListNames', 'Hello', 'Greet', 'Report'] as const;
const queue = { send: async () => {}, sendBatch: async () => {} };

async function installQueues(): Promise<void> {
	for (const binding of BINDINGS) {
		await runInDurableObject(shard(binding), (instance) => {
			(instance as any).env.TSUMUGI_QUEUE = queue;
		});
	}
}

const jobIdOf = (binding: string, name: string, occurrence: number) => `${binding}#0:${name}-${occurrence}`;

const jobStateOf = (binding: string, jobId: string) =>
	runInDurableObject(shard(binding), (instance) => (instance as any).repo.find(jobId)?.state as string | undefined);

const fired = async (binding: string, name: string, occurrence: number) =>
	(await jobStateOf(binding, jobIdOf(binding, name, occurrence))) !== undefined;

interface RunFace extends Rpc.DurableObjectBranded {
	state(): Promise<string | null>;
}

const runNamespace = env.RUN as unknown as DurableObjectNamespace<RunFace>;

const runRowOf = (runId: string) =>
	runInDurableObject(
		runNamespace.get(runNamespace.idFromName(runId)),
		(instance) => (instance as any).repo.findRun() as RunRow | undefined,
	);

async function tickAt(now: number): Promise<void> {
	await runInDurableObject(inside(), (instance) => {
		(instance as any).clock = { now: () => now };
	});
	await runDurableObjectAlarm(inside());
}

// DOストレージはテスト間で残存、行のみ削除して再作成
// deleteAllは表ごと削除, 生成済みrepoはスキーマ再作成なし
async function sync(now: number): Promise<void> {
	await installQueues();
	await runInDurableObject(inside(), async (instance) => {
		(instance as any).clock = { now: () => now };
		(instance as any).repo.sql.exec('DELETE FROM schedule');
		(instance as any).repo.sql.exec('DELETE FROM setting');
		await (instance as any).ctx.storage.deleteAlarm();
	});
	await callSync();
}

describe('定期実行(ADR-0040)', () => {
	it('syncが定義から行を作り最も早い予定へalarmを設定する', async () => {
		const base = day(0);
		await sync(base);

		const rows = await rowsOf();
		expect(rows.map((row) => row.name)).toEqual(['nightly', 'ping-hello', 'poll-names']);
		expect(await rowOf('poll-names')).toMatchObject({
			kind: 'job',
			target: 'ListNames',
			every_ms: POLL_MS,
			cron: null,
			time_zone: 'UTC',
			overlap: 'skip',
			next_occurrence_at: base + POLL_MS,
			last_occurrence_at: null,
			skipped_count: 0,
		});
		expect(await rowOf('ping-hello')).toMatchObject({ overlap: 'overlap', next_occurrence_at: base + PING_MS });
		// UTC12時は東京21時, 次の東京3時はUTC18時
		expect(await rowOf('nightly')).toMatchObject({
			kind: 'flow',
			target: 'GREETINGS',
			cron: '0 3 * * *',
			time_zone: 'Asia/Tokyo',
			next_occurrence_at: nightlyOf(base),
		});

		expect(await alarmOf()).toBe(base + PING_MS);
	});

	it('二度目のsyncは行を作り直さない', async () => {
		await sync(day(1));
		const before = await rowOf('poll-names');
		await callSync();
		expect(await rowOf('poll-names')).toEqual(before);
	});

	it('保存済み予定が現在のタイムゾーン規則と異なる場合は再計算する', async () => {
		const base = day(12);
		await sync(base);
		await runInDurableObject(inside(), (instance) => {
			(instance as any).repo.sql.exec(`UPDATE schedule SET next_occurrence_at = ? WHERE name = 'nightly'`, base + 15 * 60 * 60 * 1000);
		});

		await callSync();
		expect(await rowOf('nightly')).toMatchObject({ next_occurrence_at: nightlyOf(base) });
	});

	it('タイムゾーンの変更をタイミング変更として次回へ反映する', async () => {
		const base = day(13);
		await sync(base);
		await runInDurableObject(inside(), (instance) => {
			(instance as any).repo.sql.exec(
				`UPDATE schedule SET time_zone = 'UTC', next_occurrence_at = ? WHERE name = 'nightly'`,
				base + 15 * 60 * 60 * 1000,
			);
			(instance as any).repo.sql.exec('DELETE FROM setting');
		});

		await callSync();
		expect(await rowOf('nightly')).toMatchObject({ time_zone: 'Asia/Tokyo', next_occurrence_at: nightlyOf(base) });
	});

	it('旧スキーマをUTCで補完し既存のnext_run_atを維持する', async () => {
		const legacy = namespace.get(namespace.idFromName('scheduler-time-zone-upgrade'));
		const base = day(14);
		const existingNext = base + 123_456;
		await runInDurableObject(legacy, (instance) => {
			const sql = (instance as any).ctx.storage.sql as SqlStorage;
			sql.exec(`CREATE TABLE schedule (
				name TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				target TEXT NOT NULL,
				every_ms INTEGER,
				cron TEXT,
				overlap TEXT NOT NULL,
				next_run_at INTEGER NOT NULL,
				last_run_at INTEGER,
				last_fired_at INTEGER,
				last_job_id TEXT,
				last_run_id TEXT,
				last_skipped_at INTEGER,
				skipped_count INTEGER NOT NULL DEFAULT 0,
				last_error TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)`);
			sql.exec(
				`INSERT INTO schedule (name, kind, target, every_ms, cron, overlap, next_run_at, created_at, updated_at)
				 VALUES ('poll-names', 'job', 'ListNames', ?, NULL, 'skip', ?, ?, ?)`,
				POLL_MS,
				existingNext,
				base,
				base,
			);
			(instance as any).clock = { now: () => base };
		});

		await legacy.sync();
		const rows = (await legacy.list()) as ScheduleView[];
		expect(rows.find((row) => row.name === 'poll-names')).toMatchObject({ time_zone: 'UTC', next_occurrence_at: existingNext });
	});

	it('NULLのtime_zoneをUTCへ補正し既存のnext_run_atを維持する', async () => {
		const legacy = namespace.get(namespace.idFromName('scheduler-time-zone-null'));
		const base = day(15);
		const existingNext = base + 123_456;
		await runInDurableObject(legacy, (instance) => {
			const sql = (instance as any).ctx.storage.sql as SqlStorage;
			sql.exec(`CREATE TABLE schedule (
				name TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				target TEXT NOT NULL,
				every_ms INTEGER,
				cron TEXT,
				time_zone TEXT,
				overlap TEXT NOT NULL,
				next_run_at INTEGER NOT NULL,
				last_run_at INTEGER,
				last_fired_at INTEGER,
				last_job_id TEXT,
				last_run_id TEXT,
				last_skipped_at INTEGER,
				skipped_count INTEGER NOT NULL DEFAULT 0,
				last_error TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)`);
			sql.exec(
				`INSERT INTO schedule (name, kind, target, every_ms, cron, time_zone, overlap, next_run_at, created_at, updated_at)
				 VALUES ('poll-names', 'job', 'ListNames', ?, NULL, NULL, 'skip', ?, ?, ?)`,
				POLL_MS,
				existingNext,
				base,
				base,
			);
			(instance as any).clock = { now: () => base };
		});

		await legacy.sync();
		const rows = (await legacy.list()) as ScheduleView[];
		expect(rows.find((row) => row.name === 'poll-names')).toMatchObject({ time_zone: 'UTC', next_occurrence_at: existingNext });
	});

	it('予定時刻に決定的なIDでジョブを投入する', async () => {
		const base = day(2);
		await sync(base);
		const occurrence = base + POLL_MS;
		await tickAt(occurrence);

		const jobId = jobIdOf('ListNames', 'poll-names', occurrence);
		expect(await jobStateOf('ListNames', jobId)).toBeDefined();
		expect(await rowOf('poll-names')).toMatchObject({
			last_occurrence_at: occurrence,
			last_fired_at: occurrence,
			last_job_id: jobId,
			last_error: null,
			next_occurrence_at: occurrence + POLL_MS,
		});
	});

	it('同じ予定の再発火はジョブを作り直さない', async () => {
		const base = day(3);
		await sync(base);
		const occurrence = base + PING_MS;
		await tickAt(occurrence);

		// 終端化, 再作成時はSCHEDULEDへ遷移
		const jobId = jobIdOf('Hello', 'ping-hello', occurrence);
		await shard('Hello').cancel(jobId);
		expect(await jobStateOf('Hello', jobId)).toBe('CANCELLED');

		// 予定を戻して同時刻を再発火, 決定的IDで既存を返却(ADR-0029)
		await runInDurableObject(inside(), (instance) => {
			(instance as any).repo.markSkipped('ping-hello', occurrence, occurrence);
		});
		await tickAt(occurrence);

		expect(await jobStateOf('Hello', jobId)).toBe('CANCELLED');
	});

	it('前回が終わっていなければ省略する', async () => {
		const base = day(4);
		await sync(base);
		const first = base + POLL_MS;
		await tickAt(first);

		await tickAt(first + POLL_MS);

		expect(await fired('ListNames', 'poll-names', first + POLL_MS)).toBe(false);
		expect(await rowOf('poll-names')).toMatchObject({
			skipped_count: 1,
			last_skipped_at: first + POLL_MS,
			last_occurrence_at: first,
			next_occurrence_at: first + POLL_MS * 2,
		});
	});

	it('前回が終端に達していれば省略しない', async () => {
		const base = day(5);
		await sync(base);
		const first = base + POLL_MS;
		await tickAt(first);

		await shard('ListNames').cancel(jobIdOf('ListNames', 'poll-names', first));
		await tickAt(first + POLL_MS);

		expect(await fired('ListNames', 'poll-names', first + POLL_MS)).toBe(true);
		expect(await rowOf('poll-names')).toMatchObject({ skipped_count: 0, last_occurrence_at: first + POLL_MS });
	});

	it('重ねる指定は前回が残っていても発火する', async () => {
		const base = day(6);
		await sync(base);
		const first = base + PING_MS;
		await tickAt(first);
		await tickAt(first + PING_MS);

		expect(await fired('Hello', 'ping-hello', first)).toBe(true);
		expect(await fired('Hello', 'ping-hello', first + PING_MS)).toBe(true);
		expect(await rowOf('ping-hello')).toMatchObject({ skipped_count: 0, last_occurrence_at: first + PING_MS });
	});

	it('取り逃した周期は1回に集約して位相を保つ', async () => {
		const base = day(7);
		await sync(base);
		const first = base + PING_MS;
		await tickAt(first);

		await tickAt(first + PING_MS * 3 + 1_000);

		expect(await fired('Hello', 'ping-hello', first + PING_MS)).toBe(true);
		expect(await fired('Hello', 'ping-hello', first + PING_MS * 2)).toBe(false);
		expect(await fired('Hello', 'ping-hello', first + PING_MS * 3)).toBe(false);
		expect(await rowOf('ping-hello')).toMatchObject({
			last_occurrence_at: first + PING_MS,
			next_occurrence_at: first + PING_MS * 4,
		});
	});

	it('発火に失敗しても理由を残して次回へ進む', async () => {
		const base = day(11);
		await sync(base);
		const occurrence = nightlyOf(base);

		const restore = await runInDurableObject(inside(), (instance) => {
			const saved = (instance as any).env.RUN;
			(instance as any).env.RUN = undefined;
			return saved;
		});
		await tickAt(occurrence);
		await runInDurableObject(inside(), (instance) => {
			(instance as any).env.RUN = restore;
		});

		const row = await rowOf('nightly');
		expect(row?.last_error).toContain('RUN binding is not configured');
		// 未更新時は同じ行が先頭に残存、他scheduleが発火不能
		expect(row?.next_occurrence_at).toBe(occurrence + 24 * 60 * 60 * 1000);
		expect(row?.last_occurrence_at).toBeNull();
	});

	it('1件の失敗が他のscheduleの発火を止めない', async () => {
		const base = day(12);
		await sync(base);
		// nightlyは名前順で先頭, 同tickで後続ping-helloの発火を確認
		const occurrence = nightlyOf(base);

		const restore = await runInDurableObject(inside(), (instance) => {
			const saved = (instance as any).env.RUN;
			(instance as any).env.RUN = undefined;
			return saved;
		});
		await tickAt(occurrence);
		await runInDurableObject(inside(), (instance) => {
			(instance as any).env.RUN = restore;
		});

		expect((await rowOf('nightly'))?.last_error).not.toBeNull();
		expect((await rowOf('ping-hello'))?.last_fired_at).toBe(occurrence);
	});

	it('cronの予定でrunを起動する', async () => {
		const base = day(8);
		await sync(base);
		const occurrence = nightlyOf(base);
		await tickAt(occurrence);

		const runId = `GREETINGS:nightly-${occurrence}`;
		expect(await rowOf('nightly')).toMatchObject({
			last_occurrence_at: occurrence,
			last_run_id: runId,
			last_job_id: null,
			next_occurrence_at: occurrence + 24 * 60 * 60 * 1000,
		});

		const row = await runRowOf(runId);
		expect(row?.state).toBe('RUNNING');
		expect(row?.input).toBe(JSON.stringify({ prefix: `nightly-${occurrence}` }));
	});

	it('list()が一覧をそのまま返す', async () => {
		await sync(day(9));
		const list = await callList();
		expect(list.map((row) => row.name)).toEqual(['nightly', 'ping-hello', 'poll-names']);
		expect(list[0]).toMatchObject({ kind: 'flow', target: 'GREETINGS', time_zone: 'Asia/Tokyo', last_job_id: null, skipped_count: 0 });
	});

	it('発火の後は次の予定へalarmを再設定する', async () => {
		const base = day(10);
		await sync(base);
		const occurrence = base + PING_MS;
		await tickAt(occurrence);
		expect(await alarmOf()).toBe(occurrence + PING_MS);
	});
});

describe('一時停止と手動発火', () => {
	it('一時停止中は発火せずalarmは停止中の行を除いて設定する', async () => {
		const base = day(16);
		await sync(base);
		await inside().setPaused('ping-hello', true);
		expect(await alarmOf()).toBe(base + POLL_MS);

		const first = base + PING_MS;
		await tickAt(first);
		expect(await fired('Hello', 'ping-hello', first)).toBe(false);
		expect(await rowOf('ping-hello')).toMatchObject({ paused: 1, next_occurrence_at: first, skipped_count: 0 });
	});

	it('再開は停止中に経過した回を破棄し次の境界だけを予定する', async () => {
		const base = day(17);
		await sync(base);
		await inside().setPaused('ping-hello', true);

		const later = base + PING_MS * 3 + 1_000;
		await runInDurableObject(inside(), (instance) => {
			(instance as any).clock = { now: () => later };
		});
		await inside().setPaused('ping-hello', false);

		expect(await rowOf('ping-hello')).toMatchObject({ paused: 0, next_occurrence_at: base + PING_MS * 4 });
		expect(await fired('Hello', 'ping-hello', base + PING_MS)).toBe(false);
		expect(await alarmOf()).toBe(base + PING_MS * 4);
	});

	it('再開時に予定が未来ならそのまま維持する', async () => {
		const base = day(18);
		await sync(base);
		await inside().setPaused('poll-names', true);
		await inside().setPaused('poll-names', false);
		expect(await rowOf('poll-names')).toMatchObject({ paused: 0, next_occurrence_at: base + POLL_MS });
	});

	it('停止中でない行へのresumeは発火待ちの予定を破棄しない', async () => {
		const base = day(25);
		await sync(base);
		await runInDurableObject(inside(), (instance) => {
			(instance as any).clock = { now: () => base + PING_MS + 1_000 };
		});
		await inside().setPaused('ping-hello', false);
		expect(await rowOf('ping-hello')).toMatchObject({ paused: 0, next_occurrence_at: base + PING_MS });
	});

	it('手動発火はジョブを投入し次回の予定を進めない', async () => {
		const base = day(19);
		await sync(base);
		const jobId = `ListNames#0:poll-names-${base}-1-manual`;
		expect(await inside().trigger('poll-names')).toEqual({ ok: true, kind: 'job', id: jobId });
		expect(await jobStateOf('ListNames', jobId)).toBeDefined();
		expect(await rowOf('poll-names')).toMatchObject({
			last_occurrence_at: base,
			last_fired_at: base,
			last_job_id: jobId,
			next_occurrence_at: base + POLL_MS,
		});
	});

	it('一時停止中でも手動発火は可能', async () => {
		const base = day(20);
		await sync(base);
		await inside().setPaused('ping-hello', true);
		const jobId = `Hello#0:ping-hello-${base}-1-manual`;
		expect(await inside().trigger('ping-hello')).toEqual({ ok: true, kind: 'job', id: jobId });
		expect(await jobStateOf('Hello', jobId)).toBeDefined();
		expect(await rowOf('ping-hello')).toMatchObject({ paused: 1 });
	});

	it('手動発火でflowのrunを開始する', async () => {
		const base = day(21);
		await sync(base);
		const runId = `GREETINGS:nightly-${base}-1-manual`;
		expect(await inside().trigger('nightly')).toEqual({ ok: true, kind: 'flow', id: runId });

		const row = await runRowOf(runId);
		expect(row?.state).toBe('RUNNING');
		expect(row?.input).toBe(JSON.stringify({ prefix: `nightly-${base}` }));
	});

	it('不明な名前はnot-found', async () => {
		await sync(day(22));
		expect(await inside().setPaused('missing', true)).toEqual({ ok: false, reason: 'not-found' });
		expect(await inside().trigger('missing')).toEqual({ ok: false, reason: 'not-found' });
	});

	it('一時停止はsyncを跨いで維持される', async () => {
		const base = day(23);
		await sync(base);
		await inside().setPaused('ping-hello', true);
		await callSync();
		expect(await rowOf('ping-hello')).toMatchObject({ paused: 1 });
	});

	it('手動発火の失敗は理由を返し予定を進めない', async () => {
		const base = day(24);
		await sync(base);

		const restore = await runInDurableObject(inside(), (instance) => {
			const saved = (instance as any).env.RUN;
			(instance as any).env.RUN = undefined;
			return saved;
		});
		const result = await inside().trigger('nightly');
		await runInDurableObject(inside(), (instance) => {
			(instance as any).env.RUN = restore;
		});

		expect(result).toMatchObject({ ok: false, reason: 'failed' });
		const row = await rowOf('nightly');
		expect(row?.last_error).toContain('RUN binding is not configured');
		expect(row?.next_occurrence_at).toBe(nightlyOf(base));
	});

	it('同一時刻の手動発火は連番で区別し別に発火する', async () => {
		const base = day(26);
		await sync(base);
		const first = `ListNames#0:poll-names-${base}-1-manual`;
		const second = `ListNames#0:poll-names-${base}-2-manual`;
		expect(await inside().trigger('poll-names')).toEqual({ ok: true, kind: 'job', id: first });
		expect(await inside().trigger('poll-names')).toEqual({ ok: true, kind: 'job', id: second });
		expect(await jobStateOf('ListNames', first)).toBeDefined();
		expect(await jobStateOf('ListNames', second)).toBeDefined();
	});

	it('発火のRPC待ちの間に一時停止した行は同じtickで発火しない', async () => {
		const base = day(27);
		await sync(base);

		// ping-hello投入中の割り込みRPCでpoll-names一時停止
		const restore = await runInDurableObject(inside(), (instance) => {
			const real = (instance as any).env.JOB_SHARD;
			(instance as any).env.JOB_SHARD = {
				idFromName: (name: string) => ({ name, id: real.idFromName(name) }),
				get: (ref: { name: string; id: unknown }) => {
					const stub = real.get(ref.id);
					if (ref.name !== 'Hello#0') return stub;
					return {
						id: stub.id,
						enqueueMany: async (inputs: unknown, settings: unknown) => {
							await (instance as any).setPaused('poll-names', true);
							return stub.enqueueMany(inputs, settings);
						},
					};
				},
			};
			return real;
		});
		// 両方期限到来, 予定の早いping-helloが先に発火
		await tickAt(base + POLL_MS);
		await runInDurableObject(inside(), (instance) => {
			(instance as any).env.JOB_SHARD = restore;
		});

		expect(await fired('Hello', 'ping-hello', base + PING_MS)).toBe(true);
		expect(await fired('ListNames', 'poll-names', base + POLL_MS)).toBe(false);
		expect(await rowOf('poll-names')).toMatchObject({ paused: 1, next_occurrence_at: base + POLL_MS });
	});
});
