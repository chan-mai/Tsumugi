import { describe, expect, it } from 'vitest';
import { nextAttempt } from '../../src/core/backoff.js';
import type { Backoff } from '../../src/core/types.js';

const T0 = 1_700_000_000_000;

describe('nextAttempt', () => {
	it('試行回数を使い切ったらexhausted', () => {
		const backoff: Backoff = { kind: 'fixed', delayMs: 1_000 };
		expect(nextAttempt({ attempts: 3, maxAttempts: 3, backoff, now: T0 })).toEqual({ kind: 'exhausted' });
	});

	it('固定遅延', () => {
		const backoff: Backoff = { kind: 'fixed', delayMs: 5_000 };
		const r = nextAttempt({ attempts: 1, maxAttempts: 5, backoff, now: T0 });
		expect(r).toEqual({ kind: 'retry', runAfter: T0 + 5_000, delayMs: 5_000 });
	});

	it('指数遅延は試行ごとに伸びる', () => {
		const backoff: Backoff = { kind: 'exponential', baseMs: 1_000, factor: 2, maxMs: 3_600_000 };
		const delays = [1, 2, 3, 4].map((attempts) => {
			const r = nextAttempt({ attempts, maxAttempts: 10, backoff, now: T0 });
			return r.kind === 'retry' ? r.delayMs : -1;
		});
		expect(delays).toEqual([1_000, 2_000, 4_000, 8_000]);
	});

	it('maxMsで頭打ちになる', () => {
		// 上限が無いと試行回数の増加で遅延が際限なく伸びる
		const backoff: Backoff = { kind: 'exponential', baseMs: 1_000, factor: 2, maxMs: 10_000 };
		const r = nextAttempt({ attempts: 20, maxAttempts: 30, backoff, now: T0 });
		expect(r).toEqual({ kind: 'retry', runAfter: T0 + 10_000, delayMs: 10_000 });
	});

	it('ジッタは乱数で決まり,範囲は半分から全体まで', () => {
		// ジッタが無いと同時失敗した大量ジョブが同じ秒数で一斉に戻る
		const backoff: Backoff = { kind: 'fixed', delayMs: 10_000, jitter: true };
		const lo = nextAttempt({ attempts: 1, maxAttempts: 5, backoff, now: T0, rand: 0 });
		const hi = nextAttempt({ attempts: 1, maxAttempts: 5, backoff, now: T0, rand: 0.999999 });
		expect(lo.kind === 'retry' && lo.delayMs).toBe(5_000);
		expect(hi.kind === 'retry' && hi.delayMs).toBe(10_000);
	});

	it('ジッタありでも遅延がゼロに潰れない', () => {
		const backoff: Backoff = { kind: 'exponential', baseMs: 1_000, factor: 2, maxMs: 60_000, jitter: true };
		for (const rand of [0, 0.1, 0.5, 0.9, 0.999]) {
			const r = nextAttempt({ attempts: 1, maxAttempts: 5, backoff, now: T0, rand });
			expect(r.kind === 'retry' && r.delayMs).toBeGreaterThanOrEqual(500);
		}
	});

	it('乱数を渡さなければ決定的(テストで時間を止めやすい)', () => {
		const backoff: Backoff = { kind: 'fixed', delayMs: 8_000, jitter: true };
		const a = nextAttempt({ attempts: 1, maxAttempts: 5, backoff, now: T0 });
		const b = nextAttempt({ attempts: 1, maxAttempts: 5, backoff, now: T0 });
		expect(a).toEqual(b);
	});
});
