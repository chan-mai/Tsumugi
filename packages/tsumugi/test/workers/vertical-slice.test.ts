import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { JobContext } from '../../src/core/api.js';
import { parseJobId } from '../../src/core/ids.js';
import { fixedClock } from '../../src/do/clock.js';
import type { DispatchMessage } from '../../src/do/job-shard.js';
import { handleBatch, type ConsumerEnv } from '../../src/queue/consumer.js';

const T0 = 1_800_000_000_000;

const performed: { payload: unknown; attempt: number; jobId: string; deadlineAt: number }[] = [];

const performers = {
	HELLO: {
		perform: async (payload: { name: string }, ctx: JobContext): Promise<void> => {
			performed.push({ payload, attempt: ctx.attempt, jobId: ctx.jobId, deadlineAt: ctx.deadlineAt });
		},
	},
	BOOM: {
		perform: async (): Promise<void> => {
			throw new Error('intentional failure');
		},
	},
	ECHO: {
		perform: async (payload: { msg: string }): Promise<{ echoed: string }> => ({ echoed: payload.msg }),
	},
};

const consumerEnv: ConsumerEnv = env;

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
			throw new Error('consumer must not call retry (ADR-0004)');
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

		expect(parseJobId(jobId)).toMatchObject({ binding: 'HELLO', shard: 0 });
		expect(await stateOf('HELLO', jobId)).toBe('SCHEDULED');

		// 時刻を進めるAPI無し、alarm明示発火
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect(await stateOf('HELLO', jobId)).toBe('QUEUED');
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ jobId, binding: 'HELLO', attempt: 1 });

		const { acked, batch } = makeBatch(sent);
		await handleBatch(batch, consumerEnv, performers);
		expect(acked).toHaveLength(1);

		expect(performed).toHaveLength(1);
		expect(performed[0]).toMatchObject({ payload: { name: 'world' }, attempt: 1, jobId });
		expect(performed[0]!.deadlineAt).toBeGreaterThan(Date.now());

		expect(await stateOf('HELLO', jobId)).toBe('COMPLETED');
		const row = await runInDurableObject(shard('HELLO'), (instance) => (instance as any).repo.find(jobId) as { attempts: number });
		expect(row.attempts).toBe(1);
	});

	it('performerが例外を投げたらリトライのためSCHEDULEDへ戻る', async () => {
		const stub = shard('BOOM');
		const { sent, queue } = captureQueue();

		await runInDurableObject(stub, (instance) => {
			(instance as any).clock = fixedClock(T0);
			(instance as any).env.TSUMUGI_QUEUE = queue;
		});

		const jobId = await stub.enqueue({ binding: 'BOOM', payload: {} });
		await runDurableObjectAlarm(stub);

		const { acked, batch } = makeBatch(sent);
		await handleBatch(batch, consumerEnv, performers);

		expect(acked).toHaveLength(1);
		expect(await stateOf('BOOM', jobId)).toBe('SCHEDULED');
	});

	it('performの戻り値が保存されD1へ投影される(#9)', async () => {
		const stub = shard('ECHO');
		const { sent, queue } = captureQueue();

		await runInDurableObject(stub, (instance) => {
			(instance as any).clock = fixedClock(T0);
			(instance as any).env.TSUMUGI_QUEUE = queue;
		});

		const jobId = await stub.enqueue({ binding: 'ECHO', payload: { msg: 'hi' } });
		await runDurableObjectAlarm(stub);
		await handleBatch(makeBatch(sent).batch, consumerEnv, performers);
		expect(await stateOf('ECHO', jobId)).toBe('COMPLETED');

		const row = await runInDurableObject(shard('ECHO'), (instance) => (instance as any).repo.find(jobId) as { result: string | null });
		expect(row.result).toBe(JSON.stringify({ echoed: 'hi' }));

		await runDurableObjectAlarm(stub);
		const projected = await env.TSUMUGI_DB.prepare('SELECT result FROM job WHERE id = ?').bind(jobId).first<{ result: string | null }>();
		expect(projected?.result).toBe(JSON.stringify({ echoed: 'hi' }));
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
		await handleBatch(makeBatch(sent).batch, consumerEnv, performers);
		const after = await runInDurableObject(stub, (instance) => (instance as any).repo.writes as number);

		expect(await stateOf('HELLO', jobId)).toBe('COMPLETED');
		// insert, QUEUED遷移, COMPLETED遷移と各アウトボックス追記で6回
		// 残り1回は投影後アウトボックス削除, バッチ単位で償却
		// 6回はスパイク実測値と一致, 増加時は課金影響を確認
		expect(after - before).toBe(7);
	});
});
