import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createClient } from '../../src/client/enqueue.js';
import { fixedClock } from '../../src/do/clock.js';
import type { DispatchMessage } from '../../src/do/job-shard.js';
import { handleBatch, type ConsumerEnv } from '../../src/queue/consumer.js';

const T0 = 2_500_000_000_000;

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
		timestamp: new Date(T0),
		body,
		attempts: 1,
		ack: () => {},
		retry: () => {
			throw new Error('consumerはretryを呼んではならない(ADR-0004)');
		},
	}));
	return { queue: 'test', messages, ackAll: () => {}, retryAll: () => {} } as unknown as MessageBatch<DispatchMessage>;
}

const shard = (name: string) => env.JOB_SHARD.get(env.JOB_SHARD.idFromName(name));
const stateOf = (name: string, id: string) =>
	runInDurableObject(shard(name), (instance) => (instance as any).repo.find(id)?.state as string | undefined);

async function install(name: string, queue: unknown) {
	await runInDurableObject(shard(name), (instance) => {
		(instance as any).clock = fixedClock(T0);
		(instance as any).env.TSUMUGI_QUEUE = queue;
	});
}

describe('別Workerのperformer(ADR-0026)', () => {
	it('service binding越しに呼ばれ完了する', async () => {
		const { sent, queue } = captureQueue();
		await install('MAIL#0', queue);

		const calls: { payload: unknown; ctx: Record<string, unknown> }[] = [];
		// binding名でそのまま`env`を引く, 対応付けはwrangler設定だけが持つ(ADR-0037)
		const consumerEnv = {
			...env,
			MAIL: {
				perform: async (payload: unknown, ctx: Record<string, unknown>) => {
					calls.push({ payload, ctx });
				},
			},
		} as unknown as ConsumerEnv;

		const jobId = await shard('MAIL#0').enqueue({ binding: 'MAIL', payload: { to: 'a@example.com' } });
		await runDurableObjectAlarm(shard('MAIL#0'));
		await handleBatch(makeBatch(sent), consumerEnv);

		expect(calls).toHaveLength(1);
		expect(calls[0]!.payload).toEqual({ to: 'a@example.com' });
		expect(calls[0]!.ctx).toMatchObject({ jobId, attempt: 1, idempotencyKey: jobId });
		expect(await stateOf('MAIL#0', jobId)).toBe('COMPLETED');
	});

	it('service bindingが未設定ならリトライへ回す', async () => {
		// 捕捉して無視すると成功扱いになり, 設定漏れが完了ジョブとして残る
		const { sent, queue } = captureQueue();
		await install('MISSING#0', queue);

		const jobId = await shard('MISSING#0').enqueue({ binding: 'MISSING', payload: {} });
		await runDurableObjectAlarm(shard('MISSING#0'));
		await handleBatch(makeBatch(sent), env as ConsumerEnv);

		expect(await stateOf('MISSING#0', jobId)).toBe('SCHEDULED');
	});
});

describe('実際のservice binding越し', () => {
	// 偽のオブジェクトでは直列化もentrypointの解決も通らない,ここだけが本物の経路
	it('別Workerのentrypointが呼ばれ完了する', async () => {
		const { sent, queue } = captureQueue();
		await install('MAIL#0', queue);

		const jobId = await shard('MAIL#0').enqueue({ binding: 'MAIL', payload: { to: 'a@example.com' } });
		await runDurableObjectAlarm(shard('MAIL#0'));
		await handleBatch(makeBatch(sent), env as ConsumerEnv);

		expect(await stateOf('MAIL#0', jobId)).toBe('COMPLETED');
	});

	it('RPC境界を越えて例外が伝わりリトライへ回る', async () => {
		const { sent, queue } = captureQueue();
		await install('MAIL#0', queue);

		const jobId = await shard('MAIL#0').enqueue({ binding: 'MAIL', payload: { fail: true } });
		await runDurableObjectAlarm(shard('MAIL#0'));
		await handleBatch(makeBatch(sent), env as ConsumerEnv);

		expect(await stateOf('MAIL#0', jobId)).toBe('SCHEDULED');
	});

	it('文脈がそのまま渡りspawnも呼べる', async () => {
		// 関数はRPCのstubとして越えるので, 別Workerでもspawnが使える(ADR-0037)
		const service = (env as unknown as { MAIL: { perform(p: unknown, c: unknown): Promise<{ keys: string[]; spawned: boolean }> } }).MAIL;
		const spawned: unknown[] = [];
		const result = await service.perform(
			{ to: 'a@example.com' },
			{
				jobId: 'X#0:1',
				attempt: 1,
				idempotencyKey: 'X#0:1',
				deadlineAt: T0 + 60_000,
				spawn: (id: string, binding: string, payload: unknown) => void spawned.push({ id, binding, payload }),
			},
		);

		expect(result.keys.sort()).toEqual(['attempt', 'deadlineAt', 'idempotencyKey', 'jobId', 'spawn']);
		expect(result.spawned).toBe(true);
		expect(spawned).toEqual([{ id: 'child', binding: 'MAIL', payload: { to: 'b@example.com' } }]);
	});
});

describe('投入だけを行うclient(ADR-0023)', () => {
	it('DOの実装を参照せずに投入できる', async () => {
		const { queue } = captureQueue();
		await install('CLIENT#0', queue);

		const client = createClient({ CLIENT: { shards: 1 } });
		const ids = await client.enqueueMany(env as never, [
			{ binding: 'CLIENT', payload: { i: 0 } },
			{ binding: 'CLIENT', payload: { i: 1 } },
		]);

		expect(ids).toHaveLength(2);
		expect(await stateOf('CLIENT#0', ids[0]!)).toBe('SCHEDULED');
	});

	it('複数シャードに散っても入力の並び順でIDが返る', async () => {
		const client = createClient({ SPREAD: { shards: 4 } });
		const inputs = Array.from({ length: 12 }, (_, i) => ({ binding: 'SPREAD', payload: { i }, partitionKey: `k${i}` }));
		const ids = await client.enqueueMany(env as never, inputs);

		expect(ids).toHaveLength(12);
		expect(new Set(ids).size).toBe(12);
		// 宛先ごとの集約投入,戻す順序の誤りはIDと入力の対応崩れ
		for (const [i, id] of ids.entries()) {
			const state = await runInDurableObject(shard(id.split(':')[0]!), (instance) => (instance as any).repo.find(id)?.payload as string);
			expect(JSON.parse(state)).toEqual({ i });
		}
	});
});
