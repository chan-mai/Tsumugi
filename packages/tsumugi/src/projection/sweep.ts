import { and, asc, eq, inArray, lt, notInArray, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { DEFAULT_FAILED_RETENTION_MS } from '../core/retention.js';
import { run, runNode } from './run-tables.js';
import { job } from './tables.js';

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
	const d = drizzle(db);

	const targets = d
		.select({ id: job.id })
		.from(job)
		.where(or(and(inArray(job.state, JOB_SETTLED), lt(job.updatedAt, before)), failedJobsClause(now, olderThanMs, failed.jobs ?? {})))
		.limit(limit);

	// 件数はD1のmetaから取得, returningは削除行を全件転送
	const result = await d.delete(job).where(inArray(job.id, targets)).run();
	const failedBefore = now - Math.max(olderThanMs, failed.runs ?? DEFAULT_FAILED_RETENTION_MS);
	return (result.meta.changes ?? 0) + (await sweepRuns(db, before, failedBefore, limit));
}

const JOB_SETTLED = ['COMPLETED', 'CANCELLED'];
const JOB_FAILED = ['FAILED', 'STALLED'];

// NOTE: 保持期間が同じbindingは1条件, D1 binding変数上限対策
function failedJobsClause(now: number, olderThanMs: number, retention: Record<string, number>) {
	const fallback = Math.max(olderThanMs, DEFAULT_FAILED_RETENTION_MS);
	const groups = new Map<number, string[]>();
	for (const [binding, ms] of Object.entries(retention)) {
		const keep = Math.max(olderThanMs, ms);
		if (keep !== fallback) groups.set(keep, [...(groups.get(keep) ?? []), binding]);
	}
	const custom = [...groups.values()].flat();
	return and(
		inArray(job.state, JOB_FAILED),
		or(
			and(custom.length > 0 ? notInArray(job.binding, custom) : undefined, lt(job.updatedAt, now - fallback)),
			...[...groups].map(([keep, bindings]) => and(inArray(job.binding, bindings), lt(job.updatedAt, now - keep))),
		),
	);
}

const RUN_SETTLED = ['COMPLETED', 'CANCELLED'];

async function sweepRuns(db: D1Database, before: number, failedBefore: number, limit: number): Promise<number> {
	const d = drizzle(db);
	// ノード削除とrun削除で同じ対象を選択
	const targets = d
		.select({ id: run.id })
		.from(run)
		.where(
			or(
				and(inArray(run.state, RUN_SETTLED), lt(run.updatedAt, before)),
				and(eq(run.state, 'FAILED'), lt(run.updatedAt, failedBefore)),
			),
		)
		.orderBy(asc(run.updatedAt), asc(run.id))
		.limit(limit);
	// fan-outのrunはノード数が多く1文の削除行数を制限
	for (;;) {
		const chunk = d.select({ rowid: sql`rowid` }).from(runNode).where(inArray(runNode.runId, targets)).limit(limit);
		const removed = await d.delete(runNode).where(inArray(sql`rowid`, chunk)).run();
		if ((removed.meta.changes ?? 0) < limit) break;
	}
	const removed = await d.delete(run).where(inArray(run.id, targets)).run();
	return removed.meta.changes ?? 0;
}
