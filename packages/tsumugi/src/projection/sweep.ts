import { and, inArray, lt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { DEFAULT_FAILED_RETENTION_MS } from '../core/retention.js';
import { TERMINAL_STATES } from '../core/transitions.js';
import { job } from './tables.js';

/** 明細は個別ジョブ調査用で数日分, 傾向の時系列はAnalytics Engine側(ADR-0016) */
export type SweepOptions = {
	/** 終端ジョブのD1保持時間, 既定7日 */
	olderThanMs?: number;
	/** 1回の削除上限, 1リクエストの時間を有界に維持 */
	limit?: number;
};

export const DEFAULT_RETENTION_MS = DEFAULT_FAILED_RETENTION_MS;
const DEFAULT_SWEEP_LIMIT = 1_000;

export async function sweepReadModel(db: D1Database, now: number, options: SweepOptions = {}): Promise<number> {
	const before = now - (options.olderThanMs ?? DEFAULT_RETENTION_MS);
	const limit = options.limit ?? DEFAULT_SWEEP_LIMIT;
	const d = drizzle(db);

	const targets = d
		.select({ id: job.id })
		.from(job)
		.where(and(inArray(job.state, [...TERMINAL_STATES]), lt(job.updatedAt, before)))
		.limit(limit);

	// 件数はD1のmetaから取得, returningは削除行を全件転送
	const result = await d.delete(job).where(inArray(job.id, targets)).run();
	return result.meta.changes ?? 0;
}
