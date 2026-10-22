import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { JobContext } from '../../src/core/api.js';
import { fixedClock, type Clock } from '../../src/do/clock.js';
import type { DispatchMessage } from '../../src/do/job-shard.js';
import { handleBatch, type ConsumerEnv } from '../../src/queue/consumer.js';

const T0 = 1_900_000_000_000;
const consumerEnv: ConsumerEnv = env;

let aborted = false;

const boom = {
	perform: async (): Promise<void> => {
		throw new Error('intentional failure');
	},
};

// 自己解決するとconsumerの中断と競合し成功で終了する場合あり
const waitForDeadline = {
	perform: (_payload: unknown, ctx: JobContext): Promise<void> => {
		const signal = AbortSignal.timeout(Math.max(0, ctx.deadlineAt - Date.now()));
		return new Promise<void>(() => {
			signal.addEventListener('abort', () => {
				aborted = true;
			});
		});
	},
};

const performers = { BOOM: boom, SLOW: waitForDeadline, ONCE: boom };

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

const shard = (binding: string) => env.JOB_SHARD.get(env.JOB_SHARD.idFromName(`${binding}#0`));

// DO再生成で時計が既定へ復帰、操作直前に再設定
async function install(binding: string, clock: Clock, queue: unknown) {
	await runInDurableObject(shard(binding), (instance) => {
		(instance as any).clock = clock;
		(instance as any).env.TSUMUGI_QUEUE = queue;
	});
}

const stateOf = (binding: string, jobId: string) =>
	runInDurableObject(shard(binding), (instance) => (instance as any).repo.find(jobId)?.state as string | undefined);

const rowOf = (binding: string, jobId: string) =>
	runInDurableObject(shard(binding), (instance) => (instance as any).repo.find(jobId) as { attempts: number; run_after: number });

const alarmOf = (binding: string) => runInDurableObject(shard(binding), (_i, state) => state.storage.getAlarm());

describe('リトライ', () => {
	beforeEach(() => {
		aborted = false;
	});

	it('失敗するとバックオフぶん先の時刻にalarmが設定される', async () => {
		// 時刻を進めるAPI無し、次alarmの予定時刻で検証
		const clock = fixedClock(T0);
		const { sent, queue } = captureQueue();
		await install('BOOM', clock, queue);

		const jobId = await shard('BOOM').enqueue({
			binding: 'BOOM',
			payload: {},
			maxAttempts: 3,
			// ジッタなしで予定時刻を固定
			backoff: { kind: 'fixed', delayMs: 5_000 },
		});
		await runDurableObjectAlarm(shard('BOOM'));
		await handleBatch(makeBatch(sent), consumerEnv, performers);

		expect(await stateOf('BOOM', jobId)).toBe('SCHEDULED');
		const row = await rowOf('BOOM', jobId);
		expect(row.attempts).toBe(1);
		expect(row.run_after).toBe(T0 + 5_000);
		// 報告直後は枠の解放で即時, 次のtickで再試行時刻へ設定
		expect(await alarmOf('BOOM')).toBe(T0);
		await runDurableObjectAlarm(shard('BOOM'));
		expect(await alarmOf('BOOM')).toBe(T0 + 5_000);
	});

	it('試行回数を使い切るとFAILEDになる', async () => {
		const clock = fixedClock(T0);
		const { sent, queue } = captureQueue();
		await install('BOOM', clock, queue);

		const jobId = await shard('BOOM').enqueue({
			binding: 'BOOM',
			payload: {},
			maxAttempts: 2,
			backoff: { kind: 'fixed', delayMs: 1_000 },
		});

		for (let i = 0; i < 2; i++) {
			sent.length = 0;
			await install('BOOM', clock, queue);
			await runDurableObjectAlarm(shard('BOOM'));
			await handleBatch(makeBatch(sent), consumerEnv, performers);
			clock.advance(2_000);
		}

		expect(await stateOf('BOOM', jobId)).toBe('FAILED');
		expect((await rowOf('BOOM', jobId)).attempts).toBe(2);
	});
});

describe('timeout', () => {
	it('performerが期限を検知でき,ジョブはリトライに回る', async () => {
		const clock = fixedClock(T0);
		const { sent, queue } = captureQueue();
		await install('SLOW', clock, queue);

		const jobId = await shard('SLOW').enqueue({
			binding: 'SLOW',
			payload: {},
			timeoutMs: 50,
			maxAttempts: 3,
			backoff: { kind: 'fixed', delayMs: 1_000 },
		});
		await runDurableObjectAlarm(shard('SLOW'));
		await handleBatch(makeBatch(sent), consumerEnv, performers);

		expect(aborted).toBe(true);
		expect(await stateOf('SLOW', jobId)).toBe('SCHEDULED');
	});
});

describe('reaper', () => {
	it('無応答のat-least-onceジョブはSCHEDULEDへ戻る', async () => {
		const clock = fixedClock(T0);
		const { queue } = captureQueue();
		await install('BOOM', clock, queue);

		const jobId = await shard('BOOM').enqueue({ binding: 'BOOM', payload: {}, timeoutMs: 60_000, maxAttempts: 5 });
		await runDurableObjectAlarm(shard('BOOM'));
		expect(await stateOf('BOOM', jobId)).toBe('QUEUED');

		// 完了報告なしでtimeout + grace経過
		clock.advance(60_000 + 30_000);
		await install('BOOM', clock, queue);
		await runDurableObjectAlarm(shard('BOOM'));

		expect(await stateOf('BOOM', jobId)).toBe('SCHEDULED');
		expect((await rowOf('BOOM', jobId)).attempts).toBe(1);
	});

	it('無応答のat-most-onceジョブはSTALLEDになり再投入されない', async () => {
		const clock = fixedClock(T0);
		const { sent, queue } = captureQueue();
		await install('ONCE', clock, queue);

		const jobId = await shard('ONCE').enqueue({
			binding: 'ONCE',
			payload: {},
			guarantee: 'at-most-once',
			timeoutMs: 60_000,
		});
		await runDurableObjectAlarm(shard('ONCE'));
		expect(sent[0]?.claimRequired).toBe(true);

		clock.advance(60_000 + 30_000);
		await install('ONCE', clock, queue);
		await runDurableObjectAlarm(shard('ONCE'));

		// 再投入は二重実行の可能性、人手の判断待ち(ADR-0006 / ADR-0007)
		expect(await stateOf('ONCE', jobId)).toBe('STALLED');
	});

	it('無応答の判定境界の手前では回収しない', async () => {
		const clock = fixedClock(T0);
		const { queue } = captureQueue();
		await install('BOOM', clock, queue);

		const jobId = await shard('BOOM').enqueue({ binding: 'BOOM', payload: {}, timeoutMs: 60_000 });
		await runDurableObjectAlarm(shard('BOOM'));

		clock.advance(60_000 + 30_000 - 1);
		await install('BOOM', clock, queue);
		await runDurableObjectAlarm(shard('BOOM'));

		expect(await stateOf('BOOM', jobId)).toBe('QUEUED');
	});
});

describe('claim (ADR-0007)', () => {
	it('同時に2本claimしても勝つのは1本だけ', async () => {
		const clock = fixedClock(T0);
		const { queue } = captureQueue();
		await install('ONCE', clock, queue);

		const jobId = await shard('ONCE').enqueue({ binding: 'ONCE', payload: {}, guarantee: 'at-most-once' });
		await runDurableObjectAlarm(shard('ONCE'));

		// Queues自体がat-least-once、重複配送あり
		const results = await Promise.all([shard('ONCE').claim(jobId), shard('ONCE').claim(jobId)]);
		expect(results.filter(Boolean)).toHaveLength(1);
		expect(await stateOf('ONCE', jobId)).toBe('RUNNING');
	});
});

describe('cancel (ADR-0012)', () => {
	it('SCHEDULEDのジョブは取り消せる', async () => {
		const clock = fixedClock(T0);
		const { queue } = captureQueue();
		await install('BOOM', clock, queue);

		const jobId = await shard('BOOM').enqueue({ binding: 'BOOM', payload: {}, delayMs: 60_000 });
		expect(await shard('BOOM').cancel(jobId)).toEqual({ ok: true });
		expect(await stateOf('BOOM', jobId)).toBe('CANCELLED');
	});

	it('QUEUED以降は即時に遷移しない, 取り消しは要求として受理される', async () => {
		const clock = fixedClock(T0);
		const { queue } = captureQueue();
		await install('BOOM', clock, queue);

		const jobId = await shard('BOOM').enqueue({ binding: 'BOOM', payload: {} });
		await runDurableObjectAlarm(shard('BOOM'));
		expect(await stateOf('BOOM', jobId)).toBe('QUEUED');

		// 実行済みの可能性で即時CANCELLEDなし, 協調的要求として受理(ADR-0052)
		expect(await shard('BOOM').cancel(jobId)).toEqual({ ok: true, requested: true });
		expect(await stateOf('BOOM', jobId)).toBe('QUEUED');
	});
});
