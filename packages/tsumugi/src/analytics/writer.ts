import type { JobRow } from '../do/schema.js';

// 明細とメトリクスは要求保持期間が異なり, 明細のみsweepで削除(ADR-0016)
// 終端遷移のみ記録, 全遷移記録は件数3倍で情報増加なし
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'STALLED']);

export type MetricPoint = {
	indexes: [string];
	blobs: [string, string, string];
	doubles: [number, number];
};

export function toPoint(job: JobRow): MetricPoint | null {
	if (!TERMINAL.has(job.state)) return null;
	// dispatched_at無しは未実行で終了
	const durationMs = job.dispatched_at === null ? 0 : Math.max(0, job.updated_at - job.dispatched_at);
	return {
		// indexはサンプリング単位, binding別集計用
		indexes: [job.binding],
		blobs: [job.state, job.binding, job.guarantee],
		doubles: [job.attempts, durationMs],
	};
}

export function writeMetrics(dataset: AnalyticsEngineDataset | undefined, jobs: readonly JobRow[]): number {
	if (!dataset) return 0;
	let written = 0;
	for (const job of jobs) {
		const point = toPoint(job);
		if (!point) continue;
		dataset.writeDataPoint(point);
		written++;
	}
	return written;
}
