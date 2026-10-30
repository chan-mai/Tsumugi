import { DEFAULT_FAILED_RETENTION_MS } from '../core/retention.js';
import { and, condition, inList, notInList, or, type Condition } from '../repository/where.js';

/** 明細は個別ジョブ調査用で数日分, 傾向の時系列はAnalytics Engine側(ADR-0016) */
export type SweepOptions = {
	/** 終端ジョブと終端runのD1保持時間, 既定7日 */
	olderThanMs?: number;
	/** 1回の削除上限, 1リクエストの時間を有界に維持 */
	limit?: number;
};

/** DO側の失敗保持期間, リトライと再開が可能な行の削除防止 */
export type FailedRetention = {
	/** bindingごとの`failedRetentionMs`, 未指定bindingは既定7日 */
	jobs?: Record<string, number>;
	/** `runs.failedRetentionMs`, 既定7日 */
	runs?: number;
};

export const DEFAULT_RETENTION_MS = DEFAULT_FAILED_RETENTION_MS;
const DEFAULT_SWEEP_LIMIT = 1_000;

export async function sweepReadModel(
	db: D1Database,
	now: number,
	options: SweepOptions = {},
	failed: FailedRetention = {},
): Promise<number> {
	const olderThanMs = options.olderThanMs ?? DEFAULT_RETENTION_MS;
	const before = now - olderThanMs;
	const limit = options.limit ?? DEFAULT_SWEEP_LIMIT;
	const targets = or(
		and(inList('state', JOB_SETTLED), condition('updated_at < ?', before)),
		failedJobsClause(now, olderThanMs, failed.jobs ?? {}),
	)!;

	// 件数はD1のmetaから取得, returningは削除行を全件転送
	const result = await db
		.prepare(`DELETE FROM job WHERE id IN (SELECT id FROM job WHERE ${targets.sql} LIMIT ?)`)
		.bind(...targets.params, limit)
		.run();
	const failedBefore = now - Math.max(olderThanMs, failed.runs ?? DEFAULT_FAILED_RETENTION_MS);
	return (result.meta.changes ?? 0) + (await sweepRuns(db, before, failedBefore, limit));
}

const JOB_SETTLED = ['COMPLETED', 'CANCELLED'];
const JOB_FAILED = ['FAILED', 'STALLED'];

// NOTE: 保持期間が同じbindingは1条件, D1 binding変数上限対策
function failedJobsClause(now: number, olderThanMs: number, retention: Record<string, number>): Condition {
	const fallback = Math.max(olderThanMs, DEFAULT_FAILED_RETENTION_MS);
	const groups = new Map<number, string[]>();
	for (const [binding, ms] of Object.entries(retention)) {
		const keep = Math.max(olderThanMs, ms);
		if (keep !== fallback) groups.set(keep, [...(groups.get(keep) ?? []), binding]);
	}
	const custom = [...groups.values()].flat();
	return and(
		inList('state', JOB_FAILED),
		or(
			and(custom.length > 0 ? notInList('binding', custom) : undefined, condition('updated_at < ?', now - fallback)),
			...[...groups].map(([keep, bindings]) => and(inList('binding', bindings), condition('updated_at < ?', now - keep))),
		),
	)!;
}

const RUN_SETTLED = ['COMPLETED', 'CANCELLED'];

async function sweepRuns(db: D1Database, before: number, failedBefore: number, limit: number): Promise<number> {
	// ノード削除とrun削除で同じ対象を選択
	const where = or(
		and(inList('state', RUN_SETTLED), condition('updated_at < ?', before)),
		and(condition('state = ?', 'FAILED'), condition('updated_at < ?', failedBefore)),
	)!;
	const targets = `SELECT id FROM run WHERE ${where.sql} ORDER BY updated_at ASC, id ASC LIMIT ?`;
	const params = [...where.params, limit];
	// fan-outのrunはノード数が多く1文の削除行数を制限
	for (;;) {
		const removed = await db
			.prepare(`DELETE FROM run_node WHERE rowid IN (SELECT rowid FROM run_node WHERE run_id IN (${targets}) LIMIT ?)`)
			.bind(...params, limit)
			.run();
		if ((removed.meta.changes ?? 0) < limit) break;
	}
	const removed = await db
		.prepare(`DELETE FROM run WHERE id IN (${targets})`)
		.bind(...params)
		.run();
	return removed.meta.changes ?? 0;
}
