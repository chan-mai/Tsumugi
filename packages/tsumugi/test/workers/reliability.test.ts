import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { Performer } from '../../src/core/api.js';
import { fixedClock, type Clock } from '../../src/do/clock.js';
import type { DispatchMessage } from '../../src/do/job-shard.js';
import { handleBatch, type ConsumerEnv } from '../../src/queue/consumer.js';

const T0 = 1_900_000_000_000;
const consumerEnv: ConsumerEnv = env;

let aborted = false;

class Boom extends Performer<unknown, void, {}, ConsumerEnv> {
	async perform(): Promise<void> {
		throw new Error('意図的な失敗');
	}
}

/** abortされるまで待つ, timeoutが協調的な中断を依頼できているかを見る */
class WaitForAbort extends Performer<unknown, void, {}, ConsumerEnv> {
	async perform(_payload: unknown, ctx: { signal: AbortSignal }): Promise<void> {
		await new Promise<void>((resolve) => {
			ctx.signal.addEventListener('abort', () => {
				aborted = true;
				resolve();
			});
		});
	}
}

const registry = { BOOM: Boom, SLOW: WaitForAbort, ONCE: Boom };

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

const shard = (binding: string) => env.JOB_SHARD.get(env.JOB_SHARD.idFromName(`${binding}#0`));

/** DOは再生成されると時計が既定に戻るので,操作の直前に必ず入れ直す */
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

	it('失敗するとバックオフぶん先の時刻にalarmが張られる', async () => {
		// 時間を進めるAPIが無いので「いつ起きるつもりか」を検証する
		const clock = fixedClock(T0);
		const { sent, queue } = captureQueue();
		await install('BOOM', clock, queue);

		const jobId = await shard('BOOM').enqueue({
			binding: 'BOOM',
			payload: {},
			maxAttempts: 3,
			// ジッタ無しにして予定時刻を決定的にする
			backoff: { kind: 'fixed', delayMs: 5_000 },
		});
		await runDurableObjectAlarm(shard('BOOM'));
		await handleBatch(makeBatch(sent), consumerEnv, registry);

		expect(await stateOf('BOOM', jobId)).toBe('SCHEDULED');
		const row = await rowOf('BOOM', jobId);
		expect(row.attempts).toBe(1);
		expect(row.run_after).toBe(T0 + 5_000);
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
			await handleBatch(makeBatch(sent), consumerEnv, registry);
			clock.advance(2_000);
		}

		expect(await stateOf('BOOM', jobId)).toBe('FAILED');
		expect((await rowOf('BOOM', jobId)).attempts).toBe(2);
	});
});

describe('timeout', () => {
	it('signalがabortされ,ジョブはリトライに回る', async () => {
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
		await handleBatch(makeBatch(sent), consumerEnv, registry);

		// 待つのをやめるだけでなく中断を依頼できていること
		expect(aborted).toBe(true);
		expect(await stateOf('SLOW', jobId)).toBe('SCHEDULED');
	});
});

describe('reaper', () => {
	it('沈黙したat-least-onceジョブはSCHEDULEDへ戻る', async () => {
		const clock = fixedClock(T0);
		const { queue } = captureQueue();
		await install('BOOM', clock, queue);

		const jobId = await shard('BOOM').enqueue({ binding: 'BOOM', payload: {}, timeoutMs: 60_000, maxAttempts: 5 });
		await runDurableObjectAlarm(shard('BOOM'));
		expect(await stateOf('BOOM', jobId)).toBe('QUEUED');

		// 完了報告が届かないままtimeout + graceを過ぎた状況を作る
		clock.advance(60_000 + 30_000);
		await install('BOOM', clock, queue);
		await runDurableObjectAlarm(shard('BOOM'));

		expect(await stateOf('BOOM', jobId)).toBe('SCHEDULED');
		expect((await rowOf('BOOM', jobId)).attempts).toBe(1);
	});

	it('沈黙したat-most-onceジョブはSTALLEDになり再投入されない', async () => {
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

		// 再投入すると二重実行になり得るので人手の判断を待つ(ADR-0006 / ADR-0007)
		expect(await stateOf('ONCE', jobId)).toBe('STALLED');
	});

	it('沈黙の判定境界の手前では回収しない', async () => {
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

		// Queues自体がat-least-onceなので重複配送は起こり得る
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
		expect(await shard('BOOM').cancel(jobId)).toBe(true);
		expect(await stateOf('BOOM', jobId)).toBe('CANCELLED');
	});

	it('QUEUED以降は取り消せない,実行済みかもしれないので嘘をつかない', async () => {
		const clock = fixedClock(T0);
		const { queue } = captureQueue();
		await install('BOOM', clock, queue);

		const jobId = await shard('BOOM').enqueue({ binding: 'BOOM', payload: {} });
		await runDurableObjectAlarm(shard('BOOM'));
		expect(await stateOf('BOOM', jobId)).toBe('QUEUED');

		expect(await shard('BOOM').cancel(jobId)).toBe(false);
		expect(await stateOf('BOOM', jobId)).toBe('QUEUED');
	});
});
