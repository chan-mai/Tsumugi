import { describe, expect, it } from 'vitest';
import { Performer } from '../../src/core/api.js';
import { createTestContext, fixedClock, nextAttempt, runPerformer, schedule } from '../../src/entries/testing.js';

class Greet extends Performer<{ name: string }, string, never, unknown> {
	perform(payload: { name: string }): string {
		return `hello, ${payload.name}`;
	}
}

class Boom extends Performer<unknown, void, never, unknown> {
	perform(): void {
		throw new Error('意図的な失敗');
	}
}

/** timeoutに協調するperformer, `signal`を実物にしないとこの形が動かない */
class Interruptible extends Performer<unknown, string, never, unknown> {
	async perform(_payload: unknown, ctx: { signal: AbortSignal }): Promise<string> {
		if (ctx.signal.aborted) return 'aborted';
		return new Promise((resolve) => {
			ctx.signal.addEventListener('abort', () => resolve('aborted'), { once: true });
		});
	}
}

/** concurrencyKey必須のperformer, ハーネスが必須キー付きも受けられることの型テスト */
class Charge extends Performer<{ customerId: string }, string, { concurrencyKey: true }, unknown> {
	async perform(payload: { customerId: string }): Promise<string> {
		return payload.customerId;
	}
}

describe('performerのハーネス', () => {
	it('成功した戻り値を受け取れる', async () => {
		const result = await runPerformer(new Greet(undefined), { name: 'world' });
		expect(result).toEqual({ ok: true, value: 'hello, world' });
	});

	it('例外は投げずに結果として返る', async () => {
		// 本番では例外がリトライの判断になるので, 投げたか否かを同じ形で扱えるようにする
		const result = await runPerformer(new Boom(undefined), {});
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.error).toBeInstanceOf(Error);
	});

	it('文脈の既定値が実装と揃っている', () => {
		const ctx = createTestContext();
		// idempotencyKeyはジョブID, 再試行を跨いで同値になる
		expect(ctx.idempotencyKey).toBe(ctx.jobId);
		expect(ctx.attempt).toBe(1);
		expect(ctx.signal.aborted).toBe(false);
	});

	it('signalが実物なのでabortを待てる', async () => {
		const ctx = createTestContext();
		const running = runPerformer(new Interruptible(undefined), {}, ctx);
		ctx.abort();
		await expect(running).resolves.toEqual({ ok: true, value: 'aborted' });
	});

	it('abort済みから始められる', async () => {
		const ctx = createTestContext({ aborted: true });
		await expect(runPerformer(new Interruptible(undefined), {}, ctx)).resolves.toEqual({ ok: true, value: 'aborted' });
	});

	it('必須キー付きperformerも渡せる', async () => {
		// 第3型引数をnever固定すると必須キー付きを弾く,渡せること自体が型テスト
		const result = await runPerformer(new Charge(undefined), { customerId: 'c1' });
		expect(result).toEqual({ ok: true, value: 'c1' });
	});
});

describe('公開している純粋関数', () => {
	it('時計を明示的に進められる', () => {
		const clock = fixedClock(1_000);
		expect(clock.now()).toBe(1_000);
		clock.advance(500);
		expect(clock.now()).toBe(1_500);
	});

	it('リトライ間隔を利用者が試算できる', () => {
		const next = nextAttempt({
			attempts: 2,
			maxAttempts: 3,
			backoff: { kind: 'exponential', baseMs: 1_000, factor: 2, maxMs: 60_000 },
			now: 0,
		});
		expect(next).toEqual({ kind: 'retry', runAfter: 2_000, delayMs: 2_000 });
	});

	it('ポリシーの効き方を利用者が試せる', () => {
		const out = schedule({
			now: 0,
			jobs: [
				{
					id: 'a',
					state: 'SCHEDULED',
					priority: 0,
					attempts: 0,
					maxAttempts: 3,
					concurrencyKey: null,
					runAfter: 0,
					createdAt: 0,
					dispatchedAt: null,
					guarantee: 'at-least-once',
					timeoutMs: 1_000,
				},
			],
			policy: { concurrency: 1, perKeyConcurrency: 1, rate: null, agingIntervalMs: null, reaperGraceMs: 0 },
			bucket: { tokens: Number.POSITIVE_INFINITY, refilledAt: 0 },
		});
		expect(out.decisions).toEqual([{ type: 'dispatch', id: 'a' }]);
	});
});

describe('testingサブパスの公開API', () => {
	it('ハーネスと純粋関数の入口を公開する', async () => {
		// 依存遮断はsize-check.mjsがdist成果物で担保,ここは公開面を固定する
		const loaded = await import('../../src/entries/testing.js');
		expect(Object.keys(loaded)).toEqual(
			expect.arrayContaining(['createTestContext', 'runPerformer', 'fixedClock', 'nextAttempt', 'schedule']),
		);
	});
});
