import type { JobRow } from '../do/schema.js';

/**
 * 時系列メトリクスの書き出し(ADR-0016)
 *
 * 明細はsweepで消えるがメトリクスは残る, 両者は要求される保持期間が違う
 * 終端に達した遷移だけを書く, 全遷移を書くと件数が3倍になり得るものが増えない
 */
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'STALLED']);

export type MetricPoint = {
	indexes: [string];
	blobs: [string, string, string];
	doubles: [number, number];
};

/** 1件ぶんの計測点, 書き出し対象でなければnull */
export function toPoint(job: JobRow): MetricPoint | null {
	if (!TERMINAL.has(job.state)) return null;
	// 投入から終端までの所要, dispatched_atが無ければ実行に至らず終わったジョブ
	const durationMs = job.dispatched_at === null ? 0 : Math.max(0, job.updated_at - job.dispatched_at);
	return {
		// indexはサンプリングの単位, binding単位で見たいのでbindingを置く
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
