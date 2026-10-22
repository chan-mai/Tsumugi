import type { Retention } from './types.js';

// 投影遅延考慮
const DEFAULT_SWEEP_AFTER_MS = 5 * 60 * 1000;

// 手動再開の受付期間, D1読み取りモデルの既定保持期間と同値(ADR-0027, ADR-0034)
export const DEFAULT_FAILED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function retentionOf(settings: { sweepAfterMs?: number; failedRetentionMs?: number }): Retention {
	return {
		doneMs: settings.sweepAfterMs ?? DEFAULT_SWEEP_AFTER_MS,
		failedMs: settings.failedRetentionMs ?? DEFAULT_FAILED_RETENTION_MS,
	};
}
