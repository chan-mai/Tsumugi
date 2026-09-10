import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock, type Clock } from '../../src/do/clock.js';
import type { DispatchMessage } from '../../src/do/job-shard.js';
import { handleBatch, type ConsumerEnv } from '../../src/queue/consumer.js';

/**
 * ジョブの有効期限(ADR-0047)
 *
 * 判定はtickの投入直前とconsumerの実行直前の2箇所
 * ストレージはテストを跨いで残存, bindingをテストごとに分離
 */

// 実時刻より未来の基準, 実時刻を読むconsumer側の判定を通過する値
const T0 = 2_500_000_000_000;

const performed: unknown[] = [];

const record = {
	perform: async (payload: unknown) => {
		performed.push(payload);
	},
};

const performers = {
	EXPA: record,
	EXPB: record,
	EXPC: record,
	EXPD: record,
	EXPE: record,
	EXPF: {
		perform: async (): Promise<void> => {
			throw new Error('intentional failure');
		},
	},
};

const consumerEnv: ConsumerEnv = env;

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

function makeBatch(bodies: DispatchMessage[]) {
	const messages = bodies.map((body, i) => ({
		id: String(i),
		timestamp: new Date(0),
		body,
		attempts: 1,
		ack: () => {},
		retry: () => {
			throw new Error('consumer must not call retry (ADR-0004)');
		},
	}));
	return { queue: 'test', messages, ackAll: () => {}, retryAll: () => {} } as unknown as MessageBatch<DispatchMessage>;
}

const shard = (binding: string) => env.JOB_SHARD.get(env.JOB_SHARD.idFromName(`${binding}#0`));

/** DOは再生成されると時計が既定に戻り、操作の直前に必ず再設定 */
async function install(binding: string, clock: Clock, queue: unknown) {
	await runInDurableObject(shard(binding), (instance) => {
		(instance as any).clock = clock;
		(instance as any).env.TSUMUGI_QUEUE = queue;
	});
}

const stateOf = (binding: string, jobId: string) =>
	runInDurableObject(shard(binding), (instance) => (instance as any).repo.find(jobId)?.state as string | undefined);

const rowOf = (binding: string, jobId: string) =>
	runInDurableObject(shard(binding), (instance) => (instance as any).repo.find(jobId) as { attempts: number; expires_at: number | null });

describe('有効期限(ADR-0047)', () => {
	beforeEach(() => {
		performed.length = 0;
	});

	it('expiresInMsは投入時刻からの相対で保存される', async () => {
		await install('EXPA', fixedClock(T0), captureQueue().queue);
		const jobId = await shard('EXPA').enqueue({ binding: 'EXPA', payload: {}, expiresInMs: 5_000 });
		expect((await rowOf('EXPA', jobId)).expires_at).toBe(T0 + 5_000);
	});

	it('expiresAtはそのまま保存されexpiresInMsより優先される', async () => {
		await install('EXPB', fixedClock(T0), captureQueue().queue);
		const jobId = await shard('EXPB').enqueue({ binding: 'EXPB', payload: {}, expiresAt: T0 + 1_000, expiresInMs: 60_000 });
		expect((await rowOf('EXPB', jobId)).expires_at).toBe(T0 + 1_000);
	});

	it('期限内のジョブは実行され, メッセージに期限が入る', async () => {
		const { sent, queue } = captureQueue();
		await install('EXPC', fixedClock(T0), queue);
		const jobId = await shard('EXPC').enqueue({ binding: 'EXPC', payload: { n: 1 }, expiresInMs: 60_000 });
		await runDurableObjectAlarm(shard('EXPC'));

		expect(sent).toHaveLength(1);
		expect(sent[0]?.expiresAt).toBe(T0 + 60_000);

		await install('EXPC', fixedClock(T0), queue);
		await handleBatch(makeBatch(sent), consumerEnv, performers);
		expect(performed).toEqual([{ n: 1 }]);
		expect(await stateOf('EXPC', jobId)).toBe('COMPLETED');
	});

	it('期限を過ぎたSCHEDULEDはtickで投入されずCANCELLEDになる', async () => {
		const { sent, queue } = captureQueue();
		await install('EXPD', fixedClock(T0), queue);
		const jobId = await shard('EXPD').enqueue({ binding: 'EXPD', payload: {}, expiresInMs: 5_000 });

		// 期限の経過後に最初のtickが実行される状況, 一時停止や滞留からの復帰に相当
		await install('EXPD', fixedClock(T0 + 5_000), queue);
		await runDurableObjectAlarm(shard('EXPD'));

		expect(sent).toEqual([]);
		expect(await stateOf('EXPD', jobId)).toBe('CANCELLED');
	});

	it('Queuesで滞留したメッセージは実行の直前に期限切れになる', async () => {
		const { sent, queue } = captureQueue();
		await install('EXPE', fixedClock(T0), queue);
		const jobId = await shard('EXPE').enqueue({ binding: 'EXPE', payload: {}, expiresInMs: 60_000 });
		await runDurableObjectAlarm(shard('EXPE'));
		expect(sent).toHaveLength(1);

		// consumerの判定は実時刻を読む, 滞留で期限が過ぎた状況を期限の差し替えで再現
		const stale = { ...(sent[0] as DispatchMessage), expiresAt: Date.now() - 1 };
		await install('EXPE', fixedClock(T0), queue);
		await handleBatch(makeBatch([stale]), consumerEnv, performers);

		expect(performed).toEqual([]);
		expect(await stateOf('EXPE', jobId)).toBe('CANCELLED');
	});

	it('無応答のat-most-onceジョブは期限切れならSTALLEDではなくCANCELLEDになる', async () => {
		// consumerの期限切れ報告が失敗した場合の回復経路, reaperの判定で期限切れ
		const { sent, queue } = captureQueue();
		await install('EXPG', fixedClock(T0), queue);
		const jobId = await shard('EXPG').enqueue({
			binding: 'EXPG',
			payload: {},
			guarantee: 'at-most-once',
			timeoutMs: 1_000,
			expiresInMs: 5_000,
		});
		await runDurableObjectAlarm(shard('EXPG'));
		expect(sent).toHaveLength(1);

		// 報告のないままreaperの判定時刻と期限を経過
		await install('EXPG', fixedClock(T0 + 40_000), queue);
		await runDurableObjectAlarm(shard('EXPG'));

		expect(await stateOf('EXPG', jobId)).toBe('CANCELLED');
	});

	it('期限を越える再試行は予約されずCANCELLEDになる', async () => {
		const { sent, queue } = captureQueue();
		await install('EXPF', fixedClock(T0), queue);
		const jobId = await shard('EXPF').enqueue({
			binding: 'EXPF',
			payload: {},
			maxAttempts: 3,
			// ジッタ無しで再試行の予定時刻を期限の後ろに固定
			backoff: { kind: 'fixed', delayMs: 10_000 },
			expiresInMs: 5_000,
		});
		await runDurableObjectAlarm(shard('EXPF'));

		await install('EXPF', fixedClock(T0), queue);
		await handleBatch(makeBatch(sent), consumerEnv, performers);

		expect(await stateOf('EXPF', jobId)).toBe('CANCELLED');
		expect((await rowOf('EXPF', jobId)).attempts).toBe(1);
	});
});
