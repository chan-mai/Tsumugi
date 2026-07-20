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
		// tickは完了報告のたびに走るので, 毎回撃つと消すものが無くても書き込みが増える
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

		// enqueueが途絶えてもtickが掃除するので, 期限後は同じキーで通る
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
