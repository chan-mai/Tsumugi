import { and, asc, desc as sqlDesc, eq, gt, gte, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { attemptsOf } from '../core/attempts.js';
import type { Attempt, Job, JobListItem, JobSortKey } from '../core/entity/job.entity.js';
import type { JobLogEntry } from '../core/log.js';
import { job as readModel } from '../projection/tables.js';

// 一覧, 詳細はD1の読み取りモデルから取得(ADR-0008)
// 稼働中も投影済み, ページング, ソートは通常のSQL

// ソート許可列の対応, 列オブジェクトへ解決し許可リスト外の文字列はSQLへ未到達
// `satisfies`で全列網羅, 対応漏れは型検査で失敗
const SORT_COLUMNS = {
	updatedAt: readModel.updatedAt,
	createdAt: readModel.createdAt,
	binding: readModel.binding,
	state: readModel.state,
	priority: readModel.priority,
	attempts: readModel.attempts,
} satisfies Record<JobSortKey, unknown>;

export type JobFilters = {
	id?: string;
	uniqueKey?: string;
	concurrencyKey?: string;
	// created_atの下限, 上限, 両端含む
	createdFrom?: number;
	createdTo?: number;
};

export type JobListQuery = JobFilters & {
	state: string | null;
	binding: string | null;
	limit: number;
	offset: number;
	sort: JobSortKey;
	desc: boolean;
};

export type BulkFilter = Omit<JobFilters, 'id'> & {
	binding?: string;
	// 未指定時は操作の受理状態すべて
	states: readonly string[];
	limit: number;
};

export type RetainedFailures = {
	of: (binding: string) => number;
	bindings: readonly string[] | undefined;
};

export type JobStatsRow = { byState: Record<string, number>; oldestScheduledAt: number | null };

export interface JobRepository {
	list(query: JobListQuery): Promise<{ jobs: JobListItem[]; total: number }>;
	listBindings(): Promise<string[]>;
	// `remaining`は上限超過の残件数, 読み取りモデル遅延を含む見積り
	selectBulkTargets(
		action: 'retry' | 'cancel',
		filter: BulkFilter,
		retention: RetainedFailures | undefined,
		now: number,
	): Promise<{ ids: string[]; remaining: number }>;
	stats(): Promise<JobStatsRow>;
	find(id: string): Promise<Job | null>;
}

// 破損時も詳細画面は表示
function parseJson<T>(raw: unknown): T[] {
	if (typeof raw !== 'string' || raw.length === 0) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

// 保存形式はDOの試行行と同じsnake_case
type StoredAttempt = { attempt: number; state: string; started_at: number | null; finished_at: number; error: string | null };

export function parseAttempts(raw: unknown): Attempt[] {
	return parseJson<StoredAttempt>(raw).map((stored) => ({
		attempt: stored.attempt,
		state: stored.state,
		startedAt: stored.started_at,
		finishedAt: stored.finished_at,
		error: stored.error,
	}));
}

// DOに残る失敗ジョブの条件, retryableと同じ保持期間から近似
// 未除外では削除済み行がcreatedAt順の先頭に残り, 繰り返しても後続へ未到達
// binding未指定時は登録binding毎の条件, 登録一覧なしは近似不能で条件なし
function retainedClause(retention: RetainedFailures | undefined, binding: string | undefined, now: number): SQL | undefined {
	if (!retention) return undefined;
	const retained = (name: string) => gt(readModel.updatedAt, now - retention.of(name));
	if (binding) return retained(binding);
	if (!retention.bindings || retention.bindings.length === 0) return undefined;
	return or(...retention.bindings.map((name) => and(eq(readModel.binding, name), retained(name))));
}

export class JobReadRepository implements JobRepository {
	readonly #db: D1Database;

	constructor(db: D1Database) {
		this.#db = db;
	}

	async list(query: JobListQuery): Promise<{ jobs: JobListItem[]; total: number }> {
		const { state, binding, id, uniqueKey, concurrencyKey, createdFrom, createdTo, limit, offset, sort, desc } = query;
		const d = drizzle(this.#db);
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
		const sortBy = SORT_COLUMNS[sort];

		const [page, total] = await d.batch([
			d
				.select({
					id: readModel.id,
					binding: readModel.binding,
					state: readModel.state,
					priority: readModel.priority,
					attempts: readModel.attempts,
					maxAttempts: readModel.maxAttempts,
					createdAt: readModel.createdAt,
					updatedAt: readModel.updatedAt,
					dispatchedAt: readModel.dispatchedAt,
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

	async listBindings(): Promise<string[]> {
		const rows = await drizzle(this.#db).selectDistinct({ binding: readModel.binding }).from(readModel).orderBy(asc(readModel.binding));
		return rows.map((row) => row.binding);
	}

	async selectBulkTargets(
		action: 'retry' | 'cancel',
		filter: BulkFilter,
		retention: RetainedFailures | undefined,
		now: number,
	): Promise<{ ids: string[]; remaining: number }> {
		const { states, limit, binding, uniqueKey, concurrencyKey, createdFrom, createdTo } = filter;
		const d = drizzle(this.#db);
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

	async stats(): Promise<JobStatsRow> {
		const d = drizzle(this.#db);
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

	async find(id: string): Promise<Job | null> {
		const rows = await drizzle(this.#db).select().from(readModel).where(eq(readModel.id, id)).limit(1);
		const found = rows[0];
		if (!found) return null;
		// 返却列を明示, スプレッドでは内部列(seq)も露出
		const job: Omit<Job, 'attemptsLog'> = {
			id: found.id,
			binding: found.binding,
			state: found.state,
			priority: found.priority,
			attempts: found.attempts,
			maxAttempts: found.maxAttempts,
			concurrencyKey: found.concurrencyKey,
			uniqueKey: found.uniqueKey,
			guarantee: found.guarantee,
			createdAt: found.createdAt,
			updatedAt: found.updatedAt,
			dispatchedAt: found.dispatchedAt,
			runAfter: found.runAfter,
			expiresAt: found.expiresAt,
			cancelRequestedAt: found.cancelRequestedAt,
			progress: found.progress,
			traceparent: found.traceparent,
			logs: parseJson<JobLogEntry>(found.logs),
			payload: found.payload,
			result: found.result,
			runId: found.runId,
			nodeId: found.nodeId,
		};
		return { ...job, attemptsLog: attemptsOf(job, parseAttempts(found.attemptsLog)) };
	}
}
