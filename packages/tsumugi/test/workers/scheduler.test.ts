import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { RunRow } from '../../src/do/run-schema.js';
import type { ScheduleRow } from '../../src/do/scheduler-schema.js';
import type { ScheduleView } from '../../src/do/scheduler.js';

/**
 * 定期実行(ADR-0040)
 *
 * scheduleの定義はexamples/basicが持つ, Scheduler DOはそこから引く
 * poll-namesは固定間隔でskip, ping-helloは重ねる指定, nightlyはcronでflowを起動する
 */

const POLL_MS = 5 * 60 * 1000;
const PING_MS = 60_000;

/**
 * テストごとの起点
 * 予定を過去に置くと固定した時計と無関係にalarmが即発火するので未来に置く
 * 発火先のジョブIDは予定時刻から決まるため, テストごとに日を分けて衝突を避ける
 */
const day = (n: number) => Date.UTC(2046, 0, 5 + n, 12, 0, 0);

/** 起点の日から見た次の3時, cronは`0 3 * * *` */
const nightlyOf = (base: number) => base + 15 * 60 * 60 * 1000;

/**
 * 使う分だけを宣言する
 * DOの面をそのまま通すと戻り値の展開が深くなりTS2589に触れるので, 一覧はここでは緩く受ける
 */
interface SchedulerFace extends Rpc.DurableObjectBranded {
	sync(): Promise<void>;
	list(): Promise<unknown[]>;
}

const namespace = env.SCHEDULER as unknown as DurableObjectNamespace<SchedulerFace>;
const inside = () => namespace.get(namespace.idFromName('scheduler'));
const callSync = () => inside().sync();
const callList = async () => (await inside().list()) as ScheduleView[];
const shard = (binding: string) => env.JOB_SHARD.get(env.JOB_SHARD.idFromName(`${binding}#0`));

const rowsOf = () => runInDurableObject(inside(), (instance) => (instance as any).repo.rows() as ScheduleRow[]);
const rowOf = async (name: string) => (await rowsOf()).find((row) => row.name === name);
const alarmOf = () => runInDurableObject(inside(), (instance) => (instance as any).ctx.storage.getAlarm() as number | null);

/**
 * Job DOの投入先を差し替える
 * 実キューへ出すとconsumerが走り, 投入直後のジョブが終端へ進んでskipの判定が変わる
 */
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

/** 発火先に入ったジョブの状態, 実キューへは出さないので投入直後はSCHEDULED */
const jobStateOf = (binding: string, jobId: string) =>
	runInDurableObject(shard(binding), (instance) => (instance as any).repo.find(jobId)?.state as string | undefined);

const fired = async (binding: string, name: string, occurrence: number) =>
	(await jobStateOf(binding, jobIdOf(binding, name, occurrence))) !== undefined;

/** 発火した子のrunを覗く用, こちらも使う分だけを宣言する */
interface RunFace extends Rpc.DurableObjectBranded {
	state(): Promise<string | null>;
}

const runNamespace = env.RUN as unknown as DurableObjectNamespace<RunFace>;

const runRowOf = (runId: string) =>
	runInDurableObject(
		runNamespace.get(runNamespace.idFromName(runId)),
		(instance) => (instance as any).repo.findRun() as RunRow | undefined,
	);

/** 時計を進めてalarmを1回発火させる */
async function tickAt(now: number): Promise<void> {
	await runInDurableObject(inside(), (instance) => {
		(instance as any).clock = { now: () => now };
	});
	await runDurableObjectAlarm(inside());
}

/**
 * 定義を同期して時計を合わせる
 * DOのストレージはテストを跨いで残るので, 行だけ捨ててから作り直す
 * deleteAllは表ごと落とす, 生成済みのrepoはスキーマを張り直さないので使わない
 */
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
	it('syncが定義から行を作り最も早い予定へalarmを張る', async () => {
		const base = day(0);
		await sync(base);

		const rows = await rowsOf();
		expect(rows.map((row) => row.name)).toEqual(['nightly', 'ping-hello', 'poll-names']);
		expect(await rowOf('poll-names')).toMatchObject({
			kind: 'job',
			target: 'ListNames',
			every_ms: POLL_MS,
			cron: null,
			overlap: 'skip',
			next_run_at: base + POLL_MS,
			last_run_at: null,
			skipped_count: 0,
		});
		expect(await rowOf('ping-hello')).toMatchObject({ overlap: 'overlap', next_run_at: base + PING_MS });
		// cronはUTCの分精度, 12時から見た次の3時は翌日
		expect(await rowOf('nightly')).toMatchObject({ kind: 'flow', target: 'GREETINGS', cron: '0 3 * * *', next_run_at: nightlyOf(base) });

		expect(await alarmOf()).toBe(base + PING_MS);
	});

	it('二度目のsyncは行を作り直さない', async () => {
		await sync(day(1));
		const before = await rowOf('poll-names');
		await callSync();
		expect(await rowOf('poll-names')).toEqual(before);
	});

	it('予定時刻に決定的なIDでジョブを投入する', async () => {
		const base = day(2);
		await sync(base);
		const occurrence = base + POLL_MS;
		await tickAt(occurrence);

		const jobId = jobIdOf('ListNames', 'poll-names', occurrence);
		expect(await jobStateOf('ListNames', jobId)).toBe('SCHEDULED');
		expect(await rowOf('poll-names')).toMatchObject({
			last_run_at: occurrence,
			last_fired_at: occurrence,
			last_job_id: jobId,
			last_error: null,
			next_run_at: occurrence + POLL_MS,
		});
	});

	it('同じ予定の再発火はジョブを作り直さない', async () => {
		const base = day(3);
		await sync(base);
		const occurrence = base + PING_MS;
		await tickAt(occurrence);

		// 終端へ送っておく, 作り直されればSCHEDULEDに戻る
		const jobId = jobIdOf('Hello', 'ping-hello', occurrence);
		await shard('Hello').cancel(jobId);
		expect(await jobStateOf('Hello', jobId)).toBe('CANCELLED');

		// 予定を巻き戻して同じ時刻をもう一度迎えさせる, 決定的IDなので既存が返る(ADR-0029)
		await runInDurableObject(inside(), (instance) => {
			(instance as any).repo.markSkipped('ping-hello', occurrence, occurrence);
		});
		await tickAt(occurrence);

		expect(await jobStateOf('Hello', jobId)).toBe('CANCELLED');
	});

	it('前回が終わっていなければ飛ばす', async () => {
		const base = day(4);
		await sync(base);
		const first = base + POLL_MS;
		await tickAt(first);

		// 投入したジョブはSCHEDULEDのまま, 次の予定でskipされる
		await tickAt(first + POLL_MS);

		expect(await fired('ListNames', 'poll-names', first + POLL_MS)).toBe(false);
		expect(await rowOf('poll-names')).toMatchObject({
			skipped_count: 1,
			last_skipped_at: first + POLL_MS,
			last_run_at: first,
			next_run_at: first + POLL_MS * 2,
		});
	});

	it('前回が終端に達していれば飛ばさない', async () => {
		const base = day(5);
		await sync(base);
		const first = base + POLL_MS;
		await tickAt(first);

		// 前回を終端へ送る, 掃除済みのnullも同じく終了扱いになる
		await shard('ListNames').cancel(jobIdOf('ListNames', 'poll-names', first));
		await tickAt(first + POLL_MS);

		expect(await fired('ListNames', 'poll-names', first + POLL_MS)).toBe(true);
		expect(await rowOf('poll-names')).toMatchObject({ skipped_count: 0, last_run_at: first + POLL_MS });
	});

	it('重ねる指定は前回が残っていても発火する', async () => {
		const base = day(6);
		await sync(base);
		const first = base + PING_MS;
		await tickAt(first);
		await tickAt(first + PING_MS);

		expect(await fired('Hello', 'ping-hello', first)).toBe(true);
		expect(await fired('Hello', 'ping-hello', first + PING_MS)).toBe(true);
		expect(await rowOf('ping-hello')).toMatchObject({ skipped_count: 0, last_run_at: first + PING_MS });
	});

	it('取り逃した周期は1回に集約して位相を保つ', async () => {
		const base = day(7);
		await sync(base);
		const first = base + PING_MS;
		await tickAt(first);

		// 3周期ぶん遅れてから起きる, 溜まった予定は最も古い1回だけを発火する
		await tickAt(first + PING_MS * 3 + 1_000);

		expect(await fired('Hello', 'ping-hello', first + PING_MS)).toBe(true);
		expect(await fired('Hello', 'ping-hello', first + PING_MS * 2)).toBe(false);
		expect(await fired('Hello', 'ping-hello', first + PING_MS * 3)).toBe(false);
		// 次回は現在時刻から見た次の境界, 位相は最初の予定のまま
		expect(await rowOf('ping-hello')).toMatchObject({
			last_run_at: first + PING_MS,
			next_run_at: first + PING_MS * 4,
		});
	});

	it('発火に失敗しても理由を残して次回へ進む', async () => {
		const base = day(11);
		await sync(base);
		const occurrence = nightlyOf(base);

		// RUNのbindingを外して子のrunの起動を失敗させる
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
		// 進めないと同じ行が先頭に居座り, 他のscheduleが発火しなくなる
		expect(row?.next_run_at).toBe(occurrence + 24 * 60 * 60 * 1000);
		expect(row?.last_run_at).toBeNull();
	});

	it('1件の失敗が他のscheduleの発火を止めない', async () => {
		const base = day(12);
		await sync(base);
		// nightlyは名前順で先頭, 同じtickで後続のping-helloまで進むかを見る
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
		// ping-helloは起点から見て何周期も過ぎているので, 同じtickで発火している
		expect((await rowOf('ping-hello'))?.last_fired_at).toBe(occurrence);
	});

	it('cronの予定でrunを起動する', async () => {
		const base = day(8);
		await sync(base);
		const occurrence = nightlyOf(base);
		await tickAt(occurrence);

		const runId = `GREETINGS:nightly-${occurrence}`;
		expect(await rowOf('nightly')).toMatchObject({
			last_run_at: occurrence,
			last_run_id: runId,
			last_job_id: null,
			next_run_at: occurrence + 24 * 60 * 60 * 1000,
		});

		const row = await runRowOf(runId);
		expect(row?.state).toBe('RUNNING');
		// 写像関数は発火の予定時刻を受け取る
		expect(row?.input).toBe(JSON.stringify({ prefix: `nightly-${occurrence}` }));
	});

	it('list()が一覧をそのまま返す', async () => {
		await sync(day(9));
		const list = await callList();
		expect(list.map((row) => row.name)).toEqual(['nightly', 'ping-hello', 'poll-names']);
		expect(list[0]).toMatchObject({ kind: 'flow', target: 'GREETINGS', last_job_id: null, skipped_count: 0 });
	});

	it('発火の後は次の予定へalarmを張り直す', async () => {
		const base = day(10);
		await sync(base);
		const occurrence = base + PING_MS;
		await tickAt(occurrence);
		// 最も早い予定はping-helloの次回
		expect(await alarmOf()).toBe(occurrence + PING_MS);
	});
});
