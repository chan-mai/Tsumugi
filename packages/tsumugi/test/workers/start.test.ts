import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { JobContext } from '../../src/core/api.js';
import { fixedClock } from '../../src/do/clock.js';
import type { DispatchMessage, EnqueueInput } from '../../src/do/job-shard.js';
import { handleBatch, type ConsumerEnv } from '../../src/queue/consumer.js';

const T0 = 2_600_000_000_000;

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
			throw new Error('consumer must not call retry (ADR-0004)');
		},
	}));
	return { queue: 'test', messages, ackAll: () => {}, retryAll: () => {} } as unknown as MessageBatch<DispatchMessage>;
}

const shard = (name: string) => env.JOB_SHARD.get(env.JOB_SHARD.idFromName(name));
const rowOf = (name: string, id: string) =>
	runInDurableObject(shard(name), (instance) => {
		const row = (instance as any).repo.find(id);
		return { state: row.state as string, progress: row.progress as number | null };
	});
const projectedState = (id: string) =>
	env.TSUMUGI_DB.prepare('SELECT state FROM job WHERE id = ?')
		.bind(id)
		.first<{ state: string }>()
		.then((row) => row?.state);

async function dispatched(name: string, input: EnqueueInput) {
	const { sent, queue } = captureQueue();
	await runInDurableObject(shard(name), (instance) => {
		(instance as any).clock = fixedClock(T0);
		(instance as any).env.TSUMUGI_QUEUE = queue;
	});
	const jobId = await shard(name).enqueue(input);
	await runDurableObjectAlarm(shard(name));
	return { jobId, sent };
}

describe('at-least-onceの実行開始通知(ADR-0054)', () => {
	it('実行中はRUNNINGと投影され, 完了でCOMPLETEDになる', async () => {
		const { jobId, sent } = await dispatched('STA#0', { binding: 'STA', payload: {} });
		expect(sent[0]?.claimRequired).toBe(false);

		let during: { state: string; progress: number | null } | undefined;
		let projected: string | undefined;
		const perform = async (_payload: unknown, ctx: JobContext) => {
			await ctx.heartbeat(0.5);
			during = await rowOf('STA#0', jobId);
			await runDurableObjectAlarm(shard('STA#0'));
			projected = await projectedState(jobId);
		};
		await handleBatch(makeBatch(sent), env as ConsumerEnv, { STA: { perform } });

		// 開始通知後のheartbeat, 進捗維持
		expect(during).toEqual({ state: 'RUNNING', progress: 0.5 });
		expect(projected).toBe('RUNNING');
		expect((await rowOf('STA#0', jobId)).state).toBe('COMPLETED');
	});

	it('重複配送の2回目と前試行の通知は遷移させない', async () => {
		const { jobId } = await dispatched('STB#0', { binding: 'STB', payload: {} });

		await shard('STB#0').start(jobId, 2);
		expect((await rowOf('STB#0', jobId)).state).toBe('QUEUED');

		await shard('STB#0').start(jobId, 1);
		await shard('STB#0').heartbeat(jobId, 0.3);
		await shard('STB#0').start(jobId, 1);
		expect(await rowOf('STB#0', jobId)).toEqual({ state: 'RUNNING', progress: 0.3 });
	});

	it('終端のジョブへの遅延した通知は無視される', async () => {
		const { jobId } = await dispatched('STC#0', { binding: 'STC', payload: {} });
		await shard('STC#0').report(jobId, { ok: true });

		await shard('STC#0').start(jobId, 1);
		expect((await rowOf('STC#0', jobId)).state).toBe('COMPLETED');
	});

	it('at-most-onceはclaimでRUNNINGになる', async () => {
		const { jobId, sent } = await dispatched('STD#0', { binding: 'STD', payload: {}, guarantee: 'at-most-once' });
		expect(sent[0]?.claimRequired).toBe(true);

		let during: string | undefined;
		const perform = async () => {
			during = (await rowOf('STD#0', jobId)).state;
		};
		await handleBatch(makeBatch(sent), env as ConsumerEnv, { STD: { perform } });
		expect(during).toBe('RUNNING');
	});
});
