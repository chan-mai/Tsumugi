import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { JobContext } from '../../src/core/api.js';
import { fixedClock, type Clock } from '../../src/do/clock.js';
import type { DispatchMessage } from '../../src/do/job-shard.js';
import { handleBatch, type ConsumerEnv } from '../../src/queue/consumer.js';

const T0 = 1_900_000_000_000;
const QUEUE_WAIT = 15 * 60_000;
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

const performers = { BOOM: boom, SLOW: waitForDeadline, ONCE: boom, SLOWONCE: waitForDeadline };

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

	it('at-most-onceはtimeoutで再試行せずSTALLEDになる(ADR-0007)', async () => {
		const clock = fixedClock(T0);
		const { sent, queue } = captureQueue();
		await install('SLOWONCE', clock, queue);

		const jobId = await shard('SLOWONCE').enqueue({
			binding: 'SLOWONCE',
			payload: {},
			guarantee: 'at-most-once',
			timeoutMs: 50,
			maxAttempts: 3,
		});
		await runDurableObjectAlarm(shard('SLOWONCE'));
		await handleBatch(makeBatch(sent), consumerEnv, performers);

		// performerは実行継続, 再投入で同時に2つ実行
		expect(await stateOf('SLOWONCE', jobId)).toBe('STALLED');
		expect((await rowOf('SLOWONCE', jobId)).attempts).toBe(1);
	});
});

describe('consumerのwall time上限', () => {
	it('timeoutMsより先に上限へ達した試行は失敗として報告する', async () => {
		aborted = false;
		const clock = fixedClock(T0);
		const { sent, queue } = captureQueue();
		await install('SLOW', clock, queue);

		const jobId = await shard('SLOW').enqueue({
			binding: 'SLOW',
			payload: {},
			timeoutMs: 60_000,
			maxAttempts: 3,
			backoff: { kind: 'fixed', delayMs: 1_000 },
		});
		await runDurableObjectAlarm(shard('SLOW'));
		await handleBatch(makeBatch(sent.filter((m) => m.jobId === jobId)), consumerEnv, performers, 200);

		expect(aborted).toBe(true);
		expect(await stateOf('SLOW', jobId)).toBe('SCHEDULED');
		const attempts = await runInDurableObject(
			shard('SLOW'),
			(instance) => (instance as any).repo.attemptsOf(jobId) as { error: string | null }[],
		);
		expect(attempts.at(-1)?.error).toContain('job exceeded the consumer wall time limit');
	});

	it('at-most-onceは上限到達で再試行せずSTALLEDになる', async () => {
		const clock = fixedClock(T0);
		const { sent, queue } = captureQueue();
		await install('SLOWONCE', clock, queue);

		const jobId = await shard('SLOWONCE').enqueue({
			binding: 'SLOWONCE',
			payload: {},
			guarantee: 'at-most-once',
			timeoutMs: 60_000,
			maxAttempts: 3,
		});
		await runDurableObjectAlarm(shard('SLOWONCE'));
		await handleBatch(makeBatch(sent.filter((m) => m.jobId === jobId)), consumerEnv, performers, 200);

		expect(await stateOf('SLOWONCE', jobId)).toBe('STALLED');
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
		clock.advance(QUEUE_WAIT + 60_000 + 30_000);
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

		clock.advance(QUEUE_WAIT + 60_000 + 30_000);
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

		clock.advance(QUEUE_WAIT + 60_000 + 30_000 - 1);
		await install('BOOM', clock, queue);
		await runDurableObjectAlarm(shard('BOOM'));

		expect(await stateOf('BOOM', jobId)).toBe('QUEUED');
	});

	it('claim後は実行開始から判定しQueuesの滞留を含めない', async () => {
		const clock = fixedClock(T0);
		const { queue } = captureQueue();
		await install('ONCE', clock, queue);
		const jobId = await shard('ONCE').enqueue({ binding: 'ONCE', payload: {}, guarantee: 'at-most-once', timeoutMs: 60_000 });
		await runDurableObjectAlarm(shard('ONCE'));

		clock.advance(40_000);
		await install('ONCE', clock, queue);
		expect(await shard('ONCE').claim(jobId)).toBe(true);

		clock.advance(50_000);
		await install('ONCE', clock, queue);
		await runDurableObjectAlarm(shard('ONCE'));
		expect(await stateOf('ONCE', jobId)).toBe('RUNNING');

		clock.advance(40_000);
		await install('ONCE', clock, queue);
		await runDurableObjectAlarm(shard('ONCE'));
		expect(await stateOf('ONCE', jobId)).toBe('STALLED');
	});

	it('start後は実行開始から判定しQueuesの滞留を含めない(ADR-0054)', async () => {
		const clock = fixedClock(T0);
		const { sent, queue } = captureQueue();
		await install('BOOM', clock, queue);
		const jobId = await shard('BOOM').enqueue({ binding: 'BOOM', payload: {}, timeoutMs: 60_000, maxAttempts: 5 });
		await runDurableObjectAlarm(shard('BOOM'));

		clock.advance(40_000);
		await install('BOOM', clock, queue);
		await shard('BOOM').start(jobId, 1);

		clock.advance(50_000);
		await install('BOOM', clock, queue);
		await runDurableObjectAlarm(shard('BOOM'));
		expect(await stateOf('BOOM', jobId)).toBe('RUNNING');
		expect(sent.filter((m) => m.jobId === jobId)).toHaveLength(1);
	});
});

describe('前の試行からの通知', () => {
	// 回収後に再投入された試行2の実行中, 試行1のメッセージが遅れて処理される状況
	async function secondAttempt(binding: string, guarantee: 'at-least-once' | 'at-most-once' = 'at-least-once') {
		const clock = fixedClock(T0);
		const { queue } = captureQueue();
		await install(binding, clock, queue);
		const jobId = await shard(binding).enqueue({ binding, payload: {}, timeoutMs: 60_000, maxAttempts: 5, guarantee });
		await runDurableObjectAlarm(shard(binding));
		clock.advance(QUEUE_WAIT + 60_000 + 30_000);
		await install(binding, clock, queue);
		await runDurableObjectAlarm(shard(binding));
		if (guarantee === 'at-least-once') {
			await runDurableObjectAlarm(shard(binding));
			await shard(binding).start(jobId, 2);
		}
		return { jobId, clock, queue };
	}

	it('前の試行のreportは現在の試行へ適用しない', async () => {
		const { jobId } = await secondAttempt('STALE1');
		expect(await stateOf('STALE1', jobId)).toBe('RUNNING');

		await shard('STALE1').report(jobId, { ok: false, error: 'late failure' }, 1);
		expect(await stateOf('STALE1', jobId)).toBe('RUNNING');
		expect((await rowOf('STALE1', jobId)).attempts).toBe(1);

		await shard('STALE1').report(jobId, { ok: true }, 2);
		expect(await stateOf('STALE1', jobId)).toBe('COMPLETED');
	});

	it('重複配送の2回目のreportは試行回数を消費しない', async () => {
		const clock = fixedClock(T0);
		const { queue } = captureQueue();
		await install('STALE2', clock, queue);
		const jobId = await shard('STALE2').enqueue({ binding: 'STALE2', payload: {}, maxAttempts: 5, backoff: { kind: 'fixed', delayMs: 0 } });
		await runDurableObjectAlarm(shard('STALE2'));

		await shard('STALE2').report(jobId, { ok: false, error: 'first delivery' }, 1);
		// 試行2の投入後に同じメッセージの2回目の配送が終了
		await runDurableObjectAlarm(shard('STALE2'));
		expect(await stateOf('STALE2', jobId)).toBe('QUEUED');
		await shard('STALE2').report(jobId, { ok: false, error: 'second delivery' }, 1);
		expect(await stateOf('STALE2', jobId)).toBe('QUEUED');
		expect((await rowOf('STALE2', jobId)).attempts).toBe(1);
	});

	it('前の試行のheartbeatは受理せず回収期限を延長しない', async () => {
		const { jobId, clock, queue } = await secondAttempt('STALE3');

		expect(await shard('STALE3').heartbeat(jobId, undefined, 1)).toEqual({ accepted: false, cancelRequested: false });
		expect(await shard('STALE3').heartbeat(jobId, undefined, 2)).toEqual({ accepted: true, cancelRequested: false });

		clock.advance(60_000 + 30_000);
		await install('STALE3', clock, queue);
		await shard('STALE3').heartbeat(jobId, undefined, 1);
		await runDurableObjectAlarm(shard('STALE3'));
		expect(await stateOf('STALE3', jobId)).toBe('SCHEDULED');
	});

	it('前の試行のメッセージはclaimできない(ADR-0007)', async () => {
		const clock = fixedClock(T0);
		const { queue } = captureQueue();
		await install('STALE4', clock, queue);
		const jobId = await shard('STALE4').enqueue({
			binding: 'STALE4',
			payload: {},
			guarantee: 'at-most-once',
			maxAttempts: 5,
			backoff: { kind: 'fixed', delayMs: 0 },
		});
		await runDurableObjectAlarm(shard('STALE4'));
		// 失敗報告で試行2へ
		expect(await shard('STALE4').claim(jobId, 1)).toBe(true);
		await shard('STALE4').report(jobId, { ok: false, error: 'failure' }, 1);
		await runDurableObjectAlarm(shard('STALE4'));

		expect(await shard('STALE4').claim(jobId, 1)).toBe(false);
		expect(await shard('STALE4').claim(jobId, 2)).toBe(true);
	});
});

describe('無応答の試行の計上', () => {
	it('STALLEDからの手動リトライ後は前の試行のメッセージでclaimできない', async () => {
		const clock = fixedClock(T0);
		const { sent, queue } = captureQueue();
		await install('STALE5', clock, queue);
		const jobId = await shard('STALE5').enqueue({ binding: 'STALE5', payload: {}, guarantee: 'at-most-once', timeoutMs: 60_000 });
		await runDurableObjectAlarm(shard('STALE5'));
		clock.advance(QUEUE_WAIT + 60_000 + 30_000);
		await install('STALE5', clock, queue);
		await runDurableObjectAlarm(shard('STALE5'));
		expect(await stateOf('STALE5', jobId)).toBe('STALLED');
		expect((await rowOf('STALE5', jobId)).attempts).toBe(1);

		expect(await shard('STALE5').retry(jobId)).toEqual({ ok: true });
		await runDurableObjectAlarm(shard('STALE5'));
		expect(sent.map((m) => m.attempt)).toEqual([1, 2]);
		expect(await shard('STALE5').claim(jobId, 1)).toBe(false);
		expect(await shard('STALE5').claim(jobId, 2)).toBe(true);
	});

	it('無応答が続いてもmaxAttemptsを超えて投入しない', async () => {
		const clock = fixedClock(T0);
		const { sent, queue } = captureQueue();
		await install('STALE6', clock, queue);
		const jobId = await shard('STALE6').enqueue({ binding: 'STALE6', payload: {}, timeoutMs: 60_000, maxAttempts: 2 });
		for (let i = 0; i < 4; i++) {
			await runDurableObjectAlarm(shard('STALE6'));
			clock.advance(QUEUE_WAIT + 60_000 + 30_000);
			await install('STALE6', clock, queue);
		}
		expect(await stateOf('STALE6', jobId)).toBe('FAILED');
		expect(sent.map((m) => m.attempt)).toEqual([1, 2]);
		expect((await rowOf('STALE6', jobId)).attempts).toBe(2);

		// 手動リトライ後は新しい試行番号
		expect(await shard('STALE6').retry(jobId)).toEqual({ ok: true });
		await runDurableObjectAlarm(shard('STALE6'));
		await shard('STALE6').start(jobId, 2);
		expect(await stateOf('STALE6', jobId)).toBe('QUEUED');
		await shard('STALE6').start(jobId, 3);
		expect(await stateOf('STALE6', jobId)).toBe('RUNNING');
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

describe('configure', () => {
	it('停止の解除でalarmを設定し、待機中のジョブを投入する', async () => {
		const clock = fixedClock(T0);
		const { sent, queue } = captureQueue();
		await install('PAUSE', clock, queue);

		await shard('PAUSE').configure({ policy: { paused: true } });
		const jobId = await shard('PAUSE').enqueue({ binding: 'PAUSE', payload: {} });
		await runDurableObjectAlarm(shard('PAUSE'));
		expect(await stateOf('PAUSE', jobId)).toBe('SCHEDULED');
		expect(await alarmOf('PAUSE')).toBeNull();

		await shard('PAUSE').configure({ policy: { paused: false } });
		expect(await runDurableObjectAlarm(shard('PAUSE'))).toBe(true);
		expect(await stateOf('PAUSE', jobId)).toBe('QUEUED');
		expect(sent.map((m) => m.jobId)).toEqual([jobId]);
	});
});
