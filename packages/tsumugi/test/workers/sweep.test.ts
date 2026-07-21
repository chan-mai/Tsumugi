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

describe('DOの掃除', () => {
	it('保持期間を過ぎた終端ジョブを落とす', async () => {
		const { sent, queue } = captureQueue();
		const RETENTION = 10 * 60 * 1000;
		await install('SWEEP#0', T0, queue);
		await shard('SWEEP#0').configure({ sweepAfterMs: RETENTION });

		const jobId = await shard('SWEEP#0').enqueue({ binding: 'SWEEP', payload: {} });
		await runDurableObjectAlarm(shard('SWEEP#0'));
		await shard('SWEEP#0').report(sent[0]!.jobId, { ok: true });
		expect(await stateOf('SWEEP#0', jobId)).toBe('COMPLETED');

		// 掃除の間隔は過ぎているが保持期間の手前なので消さない
		await install('SWEEP#0', T0 + 5 * 60 * 1000, queue);
		await runDurableObjectAlarm(shard('SWEEP#0'));
		expect(await stateOf('SWEEP#0', jobId)).toBe('COMPLETED');

		await install('SWEEP#0', T0 + RETENTION + 60_000, queue);
		await runDurableObjectAlarm(shard('SWEEP#0'));
		expect(await stateOf('SWEEP#0', jobId)).toBeUndefined();
	});

	it('掃除の間隔より短い間ではDELETEを撃たない', async () => {
		// tickは完了報告のたびに走るので,毎回撃つと消すものが無くても書き込みが増える
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

	it('稼働中のジョブは落とさない', async () => {
		const { queue } = captureQueue();
		await install('SWEEP2#0', T0, queue);
		await shard('SWEEP2#0').configure({ sweepAfterMs: 1 });

		// 実行が長引いているだけのジョブを消してはならない
		const jobId = await shard('SWEEP2#0').enqueue({ binding: 'SWEEP2', payload: {}, timeoutMs: 10 ** 12 });
		await runDurableObjectAlarm(shard('SWEEP2#0'));

		await install('SWEEP2#0', T0 + 10 ** 9, queue);
		await runDurableObjectAlarm(shard('SWEEP2#0'));
		expect(await stateOf('SWEEP2#0', jobId)).toBe('QUEUED');
	});

	it('期限切れの重複排除キーを落とす', async () => {
		const { queue } = captureQueue();
		await install('SWEEP3#0', T0, queue);
		const first = await shard('SWEEP3#0').enqueue({ binding: 'SWEEP3', payload: {}, uniqueKey: 'k', uniqueForMs: 1_000 });

		// enqueueが途絶えてもtickが掃除するので,期限後は同じキーで通る
		await install('SWEEP3#0', T0 + 2_000, queue);
		await runDurableObjectAlarm(shard('SWEEP3#0'));

		await install('SWEEP3#0', T0 + 3_000, queue);
		const second = await shard('SWEEP3#0').enqueue({ binding: 'SWEEP3', payload: {}, uniqueKey: 'k', uniqueForMs: 1_000 });
		expect(second).not.toBe(first);
	});

	it('掃除しなければ溜まり続ける', async () => {
		const { queue } = captureQueue();
		await install('SWEEP4#0', T0, queue);
		await shard('SWEEP4#0').configure({ policy: { concurrency: 0 } });

		await shard('SWEEP4#0').enqueueMany(Array.from({ length: 5 }, () => ({ binding: 'SWEEP4', payload: {} })));
		expect(await countJobs('SWEEP4#0')).toBe(5);
	});
});

describe('失敗ジョブは別の保持期間を持つ(ADR-0027)', () => {
	/** 失敗させてFAILEDまで運ぶ */
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

		// 済んだ側の保持だけを過ぎた時点
		await install('SPLIT#0', T0 + 120_000, q.queue);
		await runDurableObjectAlarm(shard('SPLIT#0'));

		expect(await stateOf('SPLIT#0', done)).toBeUndefined();
		// 手動リトライの窓が開いている限り消えてはならない
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
		// 既定を短いままにすると一覧に見えるのに再開できないジョブが出る
		const q = captureQueue();
		const failed = await failJob('SPLIT3#0', 'SPLIT3', T0, q);

		await install('SPLIT3#0', T0 + 60 * 60 * 1000, q.queue);
		await runDurableObjectAlarm(shard('SPLIT3#0'));
		expect(await stateOf('SPLIT3#0', failed)).toBe('FAILED');
	});

	it('次に対象が出る時刻までalarmを飛ばす', async () => {
		// 一定間隔で起き直すと, 失敗ジョブだけが残る間ずっと何もしない書き込みが積まれる
		const q = captureQueue();
		await install('SPLIT4#0', T0, q.queue);
		await shard('SPLIT4#0').configure({ sweepAfterMs: 1_000, failedRetentionMs: 60 * 60 * 1000 });
		await failJob('SPLIT4#0', 'SPLIT4', T0, q);

		await install('SPLIT4#0', T0 + 10_000, q.queue);
		await runDurableObjectAlarm(shard('SPLIT4#0'));

		const alarm = await runInDurableObject(shard('SPLIT4#0'), (_i, state) => state.storage.getAlarm());
		// 失敗ジョブの期限は投入時刻+1時間, 短い間隔で起こしてはならない
		expect(alarm).toBeGreaterThan(T0 + 30 * 60 * 1000);
	});
});

describe('状態を変える操作はalarmを張る', () => {
	// 張らないとアウトボックスが滞留し,200を返した直後の読み取りモデルが古いまま残る
	const alarmOf = (name: string) => runInDurableObject(shard(name), (_i, state) => state.storage.getAlarm());

	it('cancelがalarmを張る', async () => {
		const { queue } = captureQueue();
		await install('CANCEL#0', T0, queue);

		const jobId = await shard('CANCEL#0').enqueue({ binding: 'CANCEL', payload: {}, delayMs: 60 * 60 * 1000 });
		// 投入直後のalarmは投影のためのnow, 1回流すと次は実行予定時刻まで飛ぶ
		await runDurableObjectAlarm(shard('CANCEL#0'));
		expect(await alarmOf('CANCEL#0')).toBe(T0 + 60 * 60 * 1000);

		expect(await shard('CANCEL#0').cancel(jobId)).toBe(true);
		expect(await alarmOf('CANCEL#0')).toBe(T0);
	});

	it('取り消せなければalarmを動かさない', async () => {
		const { sent, queue } = captureQueue();
		await install('CANCEL2#0', T0, queue);

		const jobId = await shard('CANCEL2#0').enqueue({ binding: 'CANCEL2', payload: {} });
		await runDurableObjectAlarm(shard('CANCEL2#0'));
		await shard('CANCEL2#0').report(sent[0]!.jobId, { ok: true });

		const before = await alarmOf('CANCEL2#0');
		expect(await shard('CANCEL2#0').cancel(jobId)).toBe(false);
		expect(await alarmOf('CANCEL2#0')).toBe(before);
	});
});

describe('読み取りモデルの掃除', () => {
	const insert = (id: string, state: string, updatedAt: number) =>
		env.TSUMUGI_DB.prepare(
			`INSERT INTO job (id, seq, binding, state, priority, attempts, max_attempts, guarantee, created_at, updated_at, payload)
			 VALUES (?, 1, 'RM', ?, 0, 1, 3, 'at-least-once', ?, ?, '{}')`,
		)
			.bind(id, state, updatedAt, updatedAt)
			.run();

	const exists = async (id: string) => (await env.TSUMUGI_DB.prepare('SELECT id FROM job WHERE id = ?').bind(id).first()) !== null;

	it('保持期間を過ぎた終端ジョブを落とす', async () => {
		await insert('RM#0:old', 'COMPLETED', T0 - 8 * DAY);
		await insert('RM#0:recent', 'COMPLETED', T0 - 1 * DAY);

		const removed = await sweepReadModel(env.TSUMUGI_DB, T0, { olderThanMs: 7 * DAY });

		expect(removed).toBeGreaterThanOrEqual(1);
		expect(await exists('RM#0:old')).toBe(false);
		expect(await exists('RM#0:recent')).toBe(true);
	});

	it('稼働中のジョブは古くても落とさない', async () => {
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
