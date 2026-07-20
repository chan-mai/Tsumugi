import type { Backoff } from './types.js';

export type NextAttempt = { kind: 'retry'; runAfter: number; delayMs: number } | { kind: 'exhausted' };

/**
 * 失敗後の次回実行時刻の算出
 * 上限とジッタを持たせ,同時失敗した大量ジョブが一斉に戻るのを防ぐ
 * 乱数は引数で受け取り純粋性を保つ(呼び出し側のDOがMath.random()を渡す)
 */
export function nextAttempt(args: {
	/** 失敗計上後の試行回数 */
	attempts: number;
	maxAttempts: number;
	backoff: Backoff;
	now: number;
	/** 0以上1未満, jitter有効時のみ使用 */
	rand?: number;
}): NextAttempt {
	const { attempts, maxAttempts, backoff, now, rand = 0.5 } = args;
	if (attempts >= maxAttempts) return { kind: 'exhausted' };

	const base =
		backoff.kind === 'fixed'
			? backoff.delayMs
			: Math.min(backoff.baseMs * Math.pow(backoff.factor, Math.max(0, attempts - 1)), backoff.maxMs);

	// equal jitter (半分固定+半分乱数), full jitterと違い遅延が0に潰れない
	const delayMs = backoff.jitter ? Math.round(base / 2 + rand * (base / 2)) : Math.round(base);

	return { kind: 'retry', runAfter: now + delayMs, delayMs };
}
