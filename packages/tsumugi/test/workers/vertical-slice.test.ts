import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { Performer } from '../../src/core/api.js';
import { parseJobId } from '../../src/core/ids.js';
import { fixedClock } from '../../src/do/clock.js';
import type { DispatchMessage } from '../../src/do/job-shard.js';
import { handleBatch, type ConsumerEnv } from '../../src/queue/consumer.js';

const T0 = 1_800_000_000_000;

const performed: { payload: unknown; attempt: number; jobId: string; hasSignal: boolean }[] = [];

class Hello extends Performer<{ name: string }, void, {}, ConsumerEnv> {
	async perform(payload: { name: string }, ctx: { jobId: string; attempt: number; signal: AbortSignal }): Promise<void> {
		performed.push({ payload, attempt: ctx.attempt, jobId: ctx.jobId, hasSignal: ctx.signal instanceof AbortSignal });
	}
}

class Boom extends Performer<unknown, void, {}, ConsumerEnv> {
	async perform(): Promise<void> {
		throw new Error('意図的な失敗');
	}
}

const registry = { HELLO: Hello, BOOM: Boom };

/**
 * examples/basicはビルド済みのdistからTsumugiJobShardをimportし,このテストはsrcからimportする
 * 実体は同じでも型としては別物になるため,ここで一度だけ橋渡しする
 */
const consumerEnv = env as unknown as ConsumerEnv;

/** DOに送られたメッセージを横取りしてconsumerへ手で渡す, Queuesの配送自体はここでの関心ではない */
function captureQueue() {
	const sent: DispatchMessage[] = [];
	const queue = {
		send: async (body: DispatchMessage) => {
			sent.push(body);
		},
		sendBatch: async (batch: Iterable<{ body: DispatchMessage }>) => {
			for (const m of batch) sent.push(m.body);
		},
	};
	return { sent, queue };
}

function makeBatch(bodies: DispatchMessage[]) {
	const acked: string[] = [];
	const messages = bodies.map((body, i) => ({
		id: String(i),
		timestamp: new Date(T0),
		body,
		attempts: 1,
		ack: () => {
			acked.push(String(i));
		},
		retry: () => {
			throw new Error('consumerはretryを呼んではならない(ADR-0004)');
		},
	}));
	return { acked, batch: { queue: 'test', messages, ackAll: () => {}, retryAll: () => {} } as unknown as MessageBatch<DispatchMessage> };
}

function shard(binding: string) {
	return env.JOB_SHARD.get(env.JOB_SHARD.idFromName(`${binding}#0`));
}

async function stateOf(binding: string, jobId: string): Promise<string | undefined> {
	return runInDurableObject(shard(binding), (instance) => (instance as any).repo.find(jobId)?.state);
}

describe('縦串: enqueueからCOMPLETEDまで', () => {
	beforeEach(() => {
		performed.length = 0;
	});

	it('1件のジョブが投入され実行され完了する', async () => {
		const stub = shard('HELLO');
		const { sent, queue } = captureQueue();
		const clock = fixedClock(T0);

		await runInDurableObject(stub, (instance) => {
			(instance as any).clock = clock;
			(instance as any).env.TSUMUGI_QUEUE = queue;
		});

		const jobId = await stub.enqueue({ binding: 'HELLO', payload: { name: 'world' } });

		// IDの形式(ADR-0005)
		expect(parseJobId(jobId)).toMatchObject({ binding: 'HELLO', shard: 0 });
		expect(await stateOf('HELLO', jobId)).toBe('SCHEDULED');

		// alarmを明示的に発火させる, Workersには時間を進めるAPIが無い
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect(await stateOf('HELLO', jobId)).toBe('QUEUED');
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ jobId, binding: 'HELLO', attempt: 1 });

		// consumerがperformerを呼び,必ずackする
		const { acked, batch } = makeBatch(sent);
		await handleBatch(batch, consumerEnv, registry);
		expect(acked).toHaveLength(1);

		expect(performed).toHaveLength(1);
		expect(performed[0]).toMatchObject({ payload: { name: 'world' }, attempt: 1, jobId, hasSignal: true });

		expect(await stateOf('HELLO', jobId)).toBe('COMPLETED');
	});

	it('performerが例外を投げたらFAILEDになる', async () => {
		const stub = shard('BOOM');
		const { sent, queue } = captureQueue();

		await runInDurableObject(stub, (instance) => {
			(instance as any).clock = fixedClock(T0);
			(instance as any).env.TSUMUGI_QUEUE = queue;
		});

		const jobId = await stub.enqueue({ binding: 'BOOM', payload: {} });
		await runDurableObjectAlarm(stub);

		const { acked, batch } = makeBatch(sent);
		await handleBatch(batch, consumerEnv, registry);

		// 失敗してもQueuesのretryには乗せず必ずackする(ADR-0004)
		expect(acked).toHaveLength(1);
		expect(await stateOf('BOOM', jobId)).toBe('FAILED');
	});
});

describe('DOの書き込み回数', () => {
	it('1ジョブあたりの書き込みが予算内に収まる', async () => {
		const stub = shard('HELLO');
		const { sent, queue } = captureQueue();

		await runInDurableObject(stub, (instance) => {
			(instance as any).clock = fixedClock(T0);
			(instance as any).env.TSUMUGI_QUEUE = queue;
		});

		const before = await runInDurableObject(stub, (instance) => (instance as any).repo.writes as number);
		const jobId = await stub.enqueue({ binding: 'HELLO', payload: { name: 'budget' } });
		await runDurableObjectAlarm(stub);
		await handleBatch(makeBatch(sent).batch, consumerEnv, registry);
		const after = await runInDurableObject(stub, (instance) => (instance as any).repo.writes as number);

		expect(await stateOf('HELLO', jobId)).toBe('COMPLETED');
		// insert + QUEUEDへの遷移 + COMPLETEDへの遷移 の3回
		// アウトボックス(M4)を足すと増えるので,増えたら意識的に予算を更新すること
		expect(after - before).toBe(3);
	});
});
