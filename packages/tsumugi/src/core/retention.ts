import { RETRYABLE_STATES } from './transitions.js';
import type { Retention } from './types.js';

// 投影遅延考慮
const DEFAULT_SWEEP_AFTER_MS = 5 * 60 * 1000;

// 手動再開の受付期間, D1読み取りモデルの既定保持期間と同値(ADR-0027, ADR-0034)
export const DEFAULT_FAILED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 読み取りモデルはDO行の有無を持たず保持期間から近似
 * 実際の可否はDOが判定し410が最終回答, ここは操作前の目安
 */
export function jobRetryable(row: { state: string; updatedAt: number }, now: number, retentionMs: number | undefined): boolean {
	if (!RETRYABLE_STATES.some((state) => state === row.state)) return false;
	if (retentionMs === undefined) return true;
	return row.updatedAt > now - retentionMs;
}

// 失敗のみ再開可, 保持期間後はDO削除済み(ADR-0034)
export function runRetryable(row: { state: string; updatedAt: number }, now: number, retentionMs: number | undefined): boolean {
	return row.state === 'FAILED' && (retentionMs === undefined || row.updatedAt > now - retentionMs);
}

export function retentionOf(settings: { sweepAfterMs?: number; failedRetentionMs?: number }): Retention {
	return {
		sweepAfterMs: settings.sweepAfterMs ?? DEFAULT_SWEEP_AFTER_MS,
		failedRetentionMs: settings.failedRetentionMs ?? DEFAULT_FAILED_RETENTION_MS,
	};
}
