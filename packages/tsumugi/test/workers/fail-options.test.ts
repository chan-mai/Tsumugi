import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { FailOptions, JobContext } from '../../src/core/api.js';
import { fixedClock } from '../../src/do/clock.js';
import type { DispatchMessage, EnqueueInput } from '../../src/do/job-shard.js';
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
			throw new Error('consumer must not call retry (ADR-0004)');
		},
	}));
	return { queue: 'test', messages, ackAll: () => {}, retryAll: () => {} } as unknown as MessageBatch<DispatchMessage>;
}

const shard = (name: string) => env.JOB_SHARD.get(env.JOB_SHARD.idFromName(name));
const rowOf = (name: string, id: string) =>
	runInDurableObject(shard(name), (instance) => {
		const row = (instance as any).repo.find(id);
		return {
			state: row.state as string,
			attempts: row.attempts as number,
			runAfter: row.run_after as number,
			error: (instance as any).repo.attemptsOf(id)[0]?.error as string | null,
		};
	});

async function runOnce(name: string, input: EnqueueInput, perform: (ctx: JobContext) => Promise<unknown>) {
	const { sent, queue } = captureQueue();
	await runInDurableObject(shard(name), (instance) => {
		(instance as any).clock = fixedClock(T0);
		(instance as any).env.TSUMUGI_QUEUE = queue;
	});
	const jobId = await shard(name).enqueue(input);
	await runDurableObjectAlarm(shard(name));
	await handleBatch(makeBatch(sent), env as ConsumerEnv, { [input.binding]: { perform: (_payload, ctx) => perform(ctx) } });
	return { jobId, row: await rowOf(name, jobId) };
}

const failing = (options: FailOptions) => async (ctx: JobContext) => {
	ctx.fail(options);
	throw new Error('intentional failure');
};

describe('performerからの失敗の扱いの指定(#91)', () => {
	it('retry: falseは試行回数が残っていてもFAILEDになる', async () => {
		const { row } = await runOnce('PERM#0', { binding: 'PERM', payload: {}, maxAttempts: 5 }, failing({ retry: false }));
		expect(row).toMatchObject({ state: 'FAILED', attempts: 1 });
		expect(row.error).toContain('intentional failure');
	});

	it('retryAtはbackoffに代わる次回の実行時刻になる', async () => {
		const { row } = await runOnce(
			'AT#0',
			{ binding: 'AT', payload: {}, maxAttempts: 5, backoff: { kind: 'fixed', delayMs: 1_000 } },
			failing({ retryAt: T0 + 120_000 }),
		);
		expect(row).toMatchObject({ state: 'SCHEDULED', attempts: 1, runAfter: T0 + 120_000 });
	});

	it('retryAtでも試行回数を使い切ればFAILEDになる', async () => {
		const { row } = await runOnce('ATLAST#0', { binding: 'ATLAST', payload: {}, maxAttempts: 1 }, failing({ retryAt: T0 + 120_000 }));
		expect(row).toMatchObject({ state: 'FAILED', attempts: 1 });
	});

	it('期限を越えるretryAtはCANCELLEDになる(ADR-0047)', async () => {
		const { row } = await runOnce(
			'ATEXP#0',
			{ binding: 'ATEXP', payload: {}, maxAttempts: 5, expiresAt: T0 + 60_000 },
			failing({ retryAt: T0 + 120_000 }),
		);
		expect(row.state).toBe('CANCELLED');
	});

	it('指定後に正常returnした試行は完了になる', async () => {
		const { row } = await runOnce('RET#0', { binding: 'RET', payload: {} }, async (ctx) => {
			ctx.fail({ retry: false });
			return 'done';
		});
		expect(row.state).toBe('COMPLETED');
	});

	it('最後の指定が有効になる', async () => {
		const { row } = await runOnce('LAST#0', { binding: 'LAST', payload: {}, maxAttempts: 5 }, async (ctx) => {
			ctx.fail({ retry: false });
			ctx.fail({ retryAt: T0 + 120_000 });
			throw new Error('intentional failure');
		});
		expect(row).toMatchObject({ state: 'SCHEDULED', runAfter: T0 + 120_000 });
	});

	it('取り消し要求後はretryAtを指定してもCANCELLEDになる(ADR-0052)', async () => {
		const { row } = await runOnce('CXAT#0', { binding: 'CXAT', payload: {}, maxAttempts: 5 }, async (ctx) => {
			expect(await shard('CXAT#0').cancel(ctx.jobId)).toEqual({ ok: true, requested: true });
			ctx.fail({ retryAt: T0 + 120_000 });
			throw new Error('intentional failure');
		});
		expect(row.state).toBe('CANCELLED');
	});

	it('不正な指定はperformの例外になりbackoffに従い再試行される', async () => {
		const { row } = await runOnce(
			'BAD#0',
			{ binding: 'BAD', payload: {}, maxAttempts: 5, backoff: { kind: 'fixed', delayMs: 1_000 } },
			async (ctx) => {
				ctx.fail({ retryAt: Number.NaN });
			},
		);
		expect(row).toMatchObject({ state: 'SCHEDULED', runAfter: T0 + 1_000 });
		expect(row.error).toContain('invalid fail options');
	});
});

describe('別Workerのperformerからの指定', () => {
	it.each<[FailOptions, string]>([
		[{ retry: false }, 'FAILED'],
		[{ retryAt: T0 + 120_000 }, 'SCHEDULED'],
	])('別Workerからの指定がDOの遷移に反映される(%o)', async (failWith, state) => {
		const { sent, queue } = captureQueue();
		await runInDurableObject(shard('MAIL#0'), (instance) => {
			(instance as any).clock = fixedClock(T0);
			(instance as any).env.TSUMUGI_QUEUE = queue;
		});
		const jobId = await shard('MAIL#0').enqueue({ binding: 'MAIL', payload: { failWith }, maxAttempts: 5 });
		await runDurableObjectAlarm(shard('MAIL#0'));
		await handleBatch(makeBatch(sent), env as ConsumerEnv);

		const row = await rowOf('MAIL#0', jobId);
		expect(row.state).toBe(state);
		if (state === 'SCHEDULED') expect(row.runAfter).toBe(T0 + 120_000);
	});
});
