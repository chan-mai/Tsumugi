import { and, asc, desc as sqlDesc, eq, gt, gte, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { alias } from 'drizzle-orm/sqlite-core';
import { attemptsOf, type AttemptRecord } from '../core/attempts.js';
import type { JobLogEntry } from '../core/log.js';
import { nodeTiming } from '../core/node-timing.js';
import type { SortColumn } from '../api/sort.js';
import type { BulkTarget, JobFilters } from '../api/validate.js';
import type { JobDetail, JobSummary, RunDetail, RunNode, RunSummary } from '../api/types.js';
import { job as readModel } from './tables.js';
import { run as runModel, runNode } from './run-tables.js';

// 一覧, 詳細はD1の読み取りモデルから取得(ADR-0008)
// 稼働中も投影済み, ページング, ソートは通常のSQL

// ソート許可列の対応, 列オブジェクトへ解決し許可リスト外の文字列はSQLへ未到達
// `satisfies`で全列網羅, 対応漏れは型検査で失敗
const SORT_COLUMNS = {
	updated_at: readModel.updatedAt,
	created_at: readModel.createdAt,
	binding: readModel.binding,
	state: readModel.state,
	priority: readModel.priority,
	attempts: readModel.attempts,
} satisfies Record<SortColumn, unknown>;

/** 破損行でも詳細画面は表示 */
function parseAfter(raw: unknown): string[] {
	if (typeof raw !== 'string' || raw.length === 0) return [];
	try {
		const parsed = JSON.parse(raw) as string[];
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/** 破損時も詳細画面は表示 */
function parseAttempts(raw: unknown): AttemptRecord[] {
	if (typeof raw !== 'string' || raw.length === 0) return [];
	try {
		const parsed = JSON.parse(raw) as AttemptRecord[];
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function parseJobLogs(raw: unknown): JobLogEntry[] {
	if (typeof raw !== 'string' || raw.length === 0) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

export type JobListQuery = JobFilters & {
	state: string | null;
	binding: string | null;
	limit: number;
	offset: number;
	column: SortColumn;
	desc: boolean;
};

export async function listJobs(db: D1Database, query: JobListQuery): Promise<{ jobs: Omit<JobSummary, 'retryable'>[]; total: number }> {
	const { state, binding, id, uniqueKey, concurrencyKey, createdFrom, createdTo, limit, offset, column, desc } = query;
	const d = drizzle(db);
	const filters = [
		state ? eq(readModel.state, state) : undefined,
		binding ? eq(readModel.binding, binding) : undefined,
		id ? eq(readModel.id, id) : undefined,
		uniqueKey ? eq(readModel.uniqueKey, uniqueKey) : undefined,
		concurrencyKey ? eq(readModel.concurrencyKey, concurrencyKey) : undefined,
		createdFrom !== undefined ? gte(readModel.createdAt, createdFrom) : undefined,
		createdTo !== undefined ? lte(readModel.createdAt, createdTo) : undefined,
	].filter((f) => f !== undefined);
	const clause = filters.length > 0 ? and(...filters) : undefined;
	const sortBy = SORT_COLUMNS[column];

	const [page, total] = await d.batch([
		d
			.select({
				id: readModel.id,
				binding: readModel.binding,
				state: readModel.state,
				priority: readModel.priority,
				attempts: readModel.attempts,
				max_attempts: readModel.maxAttempts,
				created_at: readModel.createdAt,
				updated_at: readModel.updatedAt,
				dispatched_at: readModel.dispatchedAt,
			})
			.from(readModel)
			.where(clause)
			.orderBy(desc ? sqlDesc(sortBy) : asc(sortBy), sqlDesc(readModel.id))
			.limit(limit)
			.offset(offset),
		d
			.select({ total: sql<number>`count(*)` })
			.from(readModel)
			.where(clause),
	]);
	return { jobs: page, total: total[0]?.total ?? 0 };
}

export async function listProjectedBindings(db: D1Database): Promise<string[]> {
	const rows = await drizzle(db).selectDistinct({ binding: readModel.binding }).from(readModel).orderBy(asc(readModel.binding));
	return rows.map((row) => row.binding);
}

export type FailedRetention = {
	of: (binding: string) => number;
	/** binding未指定時の対象, 未設定時は条件なし */
	bindings: readonly string[] | undefined;
};

// DOに残る失敗ジョブの条件, retryableと同じ保持期間から近似
// 未除外では削除済み行がcreatedAt順の先頭に残り, 繰り返しても後続へ未到達
// binding未指定時は登録binding毎の条件, 登録一覧なしは近似不能で条件なし
function retainedClause(retention: FailedRetention | undefined, binding: string | undefined, now: number): SQL | undefined {
	if (!retention) return undefined;
	const retained = (name: string) => gt(readModel.updatedAt, now - retention.of(name));
	if (binding) return retained(binding);
	if (!retention.bindings || retention.bindings.length === 0) return undefined;
	return or(...retention.bindings.map((name) => and(eq(readModel.binding, name), retained(name))));
}

/** `remaining`は上限超過の残件数, 読み取りモデル遅延を含む見積り */
export async function selectBulkTargets(
	db: D1Database,
	action: 'retry' | 'cancel',
	target: Extract<BulkTarget, { kind: 'filter' }>,
	retention: FailedRetention | undefined,
	now: number,
): Promise<{ ids: string[]; remaining: number }> {
	const { states, limit, binding, uniqueKey, concurrencyKey, createdFrom, createdTo } = target;
	const d = drizzle(db);
	const clause = and(
		...[
			inArray(readModel.state, [...states]),
			action === 'cancel' ? isNull(readModel.cancelRequestedAt) : undefined,
			action === 'retry' ? retainedClause(retention, binding, now) : undefined,
			binding ? eq(readModel.binding, binding) : undefined,
			uniqueKey ? eq(readModel.uniqueKey, uniqueKey) : undefined,
			concurrencyKey ? eq(readModel.concurrencyKey, concurrencyKey) : undefined,
			createdFrom !== undefined ? gte(readModel.createdAt, createdFrom) : undefined,
			createdTo !== undefined ? lte(readModel.createdAt, createdTo) : undefined,
		].filter((f) => f !== undefined),
	);

	// 古い順に処理, 繰り返し呼び出しで対象が減少
	const [page, total] = await d.batch([
		d.select({ id: readModel.id }).from(readModel).where(clause).orderBy(asc(readModel.createdAt), asc(readModel.id)).limit(limit),
		d
			.select({ total: sql<number>`count(*)` })
			.from(readModel)
			.where(clause),
	]);
	const ids = page.map((row) => row.id);
	return { ids, remaining: Math.max(0, (total[0]?.total ?? 0) - ids.length) };
}

export async function jobStats(db: D1Database): Promise<{ byState: Record<string, number>; oldestScheduledAt: number | null }> {
	const d = drizzle(db);
	const rows = await d
		.select({ state: readModel.state, count: sql<number>`count(*)` })
		.from(readModel)
		.groupBy(readModel.state);
	const oldest = await d
		.select({ createdAt: sql<number | null>`min(${readModel.createdAt})` })
		.from(readModel)
		.where(eq(readModel.state, 'SCHEDULED'));
	return { byState: Object.fromEntries(rows.map((r) => [r.state, r.count])), oldestScheduledAt: oldest[0]?.createdAt ?? null };
}

export async function findJob(db: D1Database, id: string): Promise<Omit<JobDetail, 'retryable'> | null> {
	const rows = await drizzle(db).select().from(readModel).where(eq(readModel.id, id)).limit(1);
	const found = rows[0];
	if (!found) return null;

	// 返却列を明示, スプレッドでは内部列(seq), camelCase重複も露出
	const job: Omit<JobDetail, 'retryable' | 'attempts_log'> = {
		id: found.id,
		binding: found.binding,
		state: found.state,
		priority: found.priority,
		attempts: found.attempts,
		max_attempts: found.maxAttempts,
		concurrency_key: found.concurrencyKey,
		unique_key: found.uniqueKey,
		guarantee: found.guarantee,
		created_at: found.createdAt,
		updated_at: found.updatedAt,
		dispatched_at: found.dispatchedAt,
		run_after: found.runAfter,
		expires_at: found.expiresAt,
		cancel_requested_at: found.cancelRequestedAt,
		progress: found.progress,
		traceparent: found.traceparent,
		logs: parseJobLogs(found.logs),
		payload: found.payload,
		// payload同様JSON文字列のまま返却
		result: found.result,
		run_id: found.runId,
		node_id: found.nodeId,
	};
	// 履歴は詳細のみ, 一覧では1画面数百KBの可能性(ADR-0028)
	// `attempts`は試行回数で別名使用, 上書きで画面のn/m表示が破損
	return { ...job, attempts_log: attemptsOf(job, parseAttempts(found.attemptsLog)) };
}

export async function listRuns(
	db: D1Database,
	query: { state: string | null; flow: string | null; limit: number; offset: number },
): Promise<{ runs: RunSummary[]; total: number }> {
	const { state, flow, limit, offset } = query;
	const d = drizzle(db);
	const filters = [state ? eq(runModel.state, state) : undefined, flow ? eq(runModel.flow, flow) : undefined].filter(
		(f) => f !== undefined,
	);
	const clause = filters.length > 0 ? and(...filters) : undefined;

	const [page, total] = await d.batch([
		d
			.select({
				id: runModel.id,
				flow: runModel.flow,
				state: runModel.state,
				node_total: runModel.nodeTotal,
				node_done: runModel.nodeDone,
				node_failed: runModel.nodeFailed,
				created_at: runModel.createdAt,
				updated_at: runModel.updatedAt,
			})
			.from(runModel)
			.where(clause)
			.orderBy(sqlDesc(runModel.updatedAt), sqlDesc(runModel.id))
			.limit(limit)
			.offset(offset),
		d
			.select({ total: sql<number>`count(*)` })
			.from(runModel)
			.where(clause),
	]);
	return { runs: page, total: total[0]?.total ?? 0 };
}

// グラフは1クエリで返却, 段組み描画に全ノード必要
export async function findRun(db: D1Database, id: string): Promise<{ run: Omit<RunDetail, 'retryable'>; nodes: RunNode[] } | null> {
	const d = drizzle(db);
	const childRun = alias(runModel, 'child_run');
	const [runs, nodes] = await d.batch([
		d.select().from(runModel).where(eq(runModel.id, id)).limit(1),

		d
			.select({
				node: runNode,
				job: {
					state: sql<string>`${readModel.state}`.as('job_state'),
					attempts: sql<number>`${readModel.attempts}`.as('job_attempts'),
					createdAt: sql<number>`${readModel.createdAt}`.as('job_created_at'),
					updatedAt: sql<number>`${readModel.updatedAt}`.as('job_updated_at'),
					dispatchedAt: sql<number | null>`${readModel.dispatchedAt}`.as('job_dispatched_at'),
					runAfter: sql<number | null>`${readModel.runAfter}`.as('job_run_after'),
					attemptsLog: sql<string | null>`${readModel.attemptsLog}`.as('job_attempts_log'),
				},
				child: {
					state: sql<string>`${childRun.state}`.as('child_state'),
					createdAt: sql<number>`${childRun.createdAt}`.as('child_created_at'),
					updatedAt: sql<number>`${childRun.updatedAt}`.as('child_updated_at'),
				},
			})
			.from(runNode)
			.leftJoin(readModel, eq(readModel.id, runNode.jobId))
			.leftJoin(childRun, eq(childRun.id, runNode.childRunId))
			.where(eq(runNode.runId, id))
			.orderBy(asc(runNode.position)),
	]);

	const found = runs[0];
	if (!found) return null;
	return {
		run: {
			id: found.id,
			flow: found.flow,
			state: found.state,
			input: found.input,
			node_total: found.nodeTotal,
			node_done: found.nodeDone,
			node_failed: found.nodeFailed,
			created_at: found.createdAt,
			updated_at: found.updatedAt,
			parent_run_id: found.parentRunId,
			parent_node_id: found.parentNodeId,
		},
		nodes: nodes.map(({ node, job: joined, child: joinedChild }) => {
			// 結合先なしは全列null
			const job = joined?.state != null ? joined : null;
			const child = joinedChild?.state != null ? joinedChild : null;
			const timing = nodeTiming(job, child);
			return {
				id: node.nodeId,
				binding: node.binding,
				state: node.state,
				container: node.container === 1,
				parent: node.parent,
				origin: node.origin,
				after: parseAfter(node.after),
				job_id: node.jobId,
				child_run_id: node.childRunId,
				result: node.result,
				error: node.error,
				position: node.position,
				created_at: node.createdAt,
				updated_at: node.updatedAt,
				queued_at: timing.queuedAt,
				run_after: timing.runAfter,
				started_at: timing.startedAt,
				finished_at: timing.finishedAt,
				attempts_log: job
					? attemptsOf(
							{ state: job.state, attempts: job.attempts, dispatched_at: job.dispatchedAt, updated_at: job.updatedAt },
							parseAttempts(job.attemptsLog),
						).map((attempt) => ({ ...attempt, error: null }))
					: [],
			};
		}),
	};
}
