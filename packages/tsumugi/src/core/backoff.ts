import type { Backoff } from './types.js';

export type NextAttempt = { kind: 'retry'; runAfter: number; delayMs: number } | { kind: 'exhausted' };

/**
 * 上限とジッタで同時失敗した大量ジョブの一斉再実行を防止
 * 乱数は引数渡し, 純粋性維持
 */
export function nextAttempt(args: {
	/** 失敗計上後の試行回数 */
	attempts: number;
	maxAttempts: number;
	backoff: Backoff;
	now: number;
	/** 0以上1未満, jitter有効時のみ使用 */
	rand?: number;
	/** performer指定の次回時刻(#91) */
	retryAt?: number;
}): NextAttempt {
	const { attempts, maxAttempts, backoff, now, rand = 0.5, retryAt } = args;
	if (attempts >= maxAttempts) return { kind: 'exhausted' };
	if (retryAt !== undefined) {
		const runAfter = Math.max(now, retryAt);
		return { kind: 'retry', runAfter, delayMs: runAfter - now };
	}

	const base =
		backoff.kind === 'fixed'
			? backoff.delayMs
			: Math.min(backoff.baseMs * Math.pow(backoff.factor, Math.max(0, attempts - 1)), backoff.maxMs);

	// equal jitter(半分固定+半分乱数), full jitterと違い遅延0を回避
	const delayMs = backoff.jitter ? Math.round(base / 2 + rand * (base / 2)) : Math.round(base);

	return { kind: 'retry', runAfter: now + delayMs, delayMs };
}
