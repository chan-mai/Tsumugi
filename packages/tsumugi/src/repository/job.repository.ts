import { attemptsOf } from '../core/attempts.js';
import type { Attempt, Job, JobListItem, JobSortKey } from '../core/entity/job.entity.js';
import type { JobLogEntry } from '../core/log.js';
import { READ_MODEL_COLUMNS, type ReadModelRow } from '../projection/columns.js';
import { and, condition, inList, or, whereOf, type Condition } from './where.js';

// 一覧, 詳細はD1の読み取りモデルから取得(ADR-0008)
// 稼働中も投影済み, ページング, ソートは通常のSQL

// ソート許可列の対応, 列名へ解決し許可リスト外の文字列はSQLへ未到達
// `satisfies`で全列網羅, 対応漏れは型検査で失敗
const SORT_COLUMNS = {
	updatedAt: 'updated_at',
	createdAt: 'created_at',
	binding: 'binding',
	state: 'state',
	priority: 'priority',
	attempts: 'attempts',
} satisfies Record<JobSortKey, string>;

const LIST_COLUMNS = `id, binding, state, priority, attempts, max_attempts AS "maxAttempts", created_at AS "createdAt",
	updated_at AS "updatedAt", dispatched_at AS "dispatchedAt"`;

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

type JobStatsRow = { byState: Record<string, number>; oldestScheduledAt: number | null };

type StoredJob = ReadModelRow<'job'> & {
	id: string;
	binding: string;
	state: string;
	priority: number;
	attempts: number;
	max_attempts: number;
	concurrency_key: string | null;
	unique_key: string | null;
	guarantee: string;
	created_at: number;
	updated_at: number;
	dispatched_at: number | null;
	run_after: number | null;
	expires_at: number | null;
	cancel_requested_at: number | null;
	progress: number | null;
	payload: string;
	result: string | null;
	traceparent: string | null;
	run_id: string | null;
	node_id: string | null;
	attempts_log: string | null;
	logs: string | null;
};

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
export function parseJson<T>(raw: unknown): T[] {
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
function retainedClause(retention: RetainedFailures | undefined, binding: string | undefined, now: number): Condition | undefined {
	if (!retention) return undefined;
	const retained = (name: string) => condition('updated_at > ?', now - retention.of(name));
	if (binding) return retained(binding);
	if (!retention.bindings || retention.bindings.length === 0) return undefined;
	return or(...retention.bindings.map((name) => and(condition('binding = ?', name), retained(name))));
}

// フィルタ共通の条件
function filtersOf(filters: JobFilters & { binding?: string | null }): (Condition | undefined)[] {
	const { binding, id, uniqueKey, concurrencyKey, createdFrom, createdTo } = filters;
	return [
		binding ? condition('binding = ?', binding) : undefined,
		id ? condition('id = ?', id) : undefined,
		uniqueKey ? condition('unique_key = ?', uniqueKey) : undefined,
		concurrencyKey ? condition('concurrency_key = ?', concurrencyKey) : undefined,
		createdFrom !== undefined ? condition('created_at >= ?', createdFrom) : undefined,
		createdTo !== undefined ? condition('created_at <= ?', createdTo) : undefined,
	];
}

export class JobReadRepository implements JobRepository {
	readonly #db: D1Database;

	constructor(db: D1Database) {
		this.#db = db;
	}

	async list(query: JobListQuery): Promise<{ jobs: JobListItem[]; total: number }> {
		const { state, limit, offset, sort, desc } = query;
		const where = whereOf(and(state ? condition('state = ?', state) : undefined, ...filtersOf(query)));
		const order = `${SORT_COLUMNS[sort]} ${desc ? 'DESC' : 'ASC'}, id DESC`;

		const [page, total] = await this.#db.batch([
			this.#db
				.prepare(`SELECT ${LIST_COLUMNS} FROM job${where.sql} ORDER BY ${order} LIMIT ? OFFSET ?`)
				.bind(...where.params, limit, offset),
			this.#db.prepare(`SELECT count(*) AS total FROM job${where.sql}`).bind(...where.params),
		]);
		return { jobs: page!.results as JobListItem[], total: (total!.results[0] as { total: number } | undefined)?.total ?? 0 };
	}

	async listBindings(): Promise<string[]> {
		const { results } = await this.#db.prepare(`SELECT DISTINCT binding FROM job ORDER BY binding ASC`).all<{ binding: string }>();
		return results.map((row) => row.binding);
	}

	async selectBulkTargets(
		action: 'retry' | 'cancel',
		filter: BulkFilter,
		retention: RetainedFailures | undefined,
		now: number,
	): Promise<{ ids: string[]; remaining: number }> {
		const { states, limit, binding } = filter;
		const where = whereOf(
			and(
				inList('state', states),
				action === 'cancel' ? condition('cancel_requested_at IS NULL') : undefined,
				action === 'retry' ? retainedClause(retention, binding, now) : undefined,
				...filtersOf(filter),
			),
		);

		// 古い順に処理, 繰り返し呼び出しで対象が減少
		const [page, total] = await this.#db.batch([
			this.#db.prepare(`SELECT id FROM job${where.sql} ORDER BY created_at ASC, id ASC LIMIT ?`).bind(...where.params, limit),
			this.#db.prepare(`SELECT count(*) AS total FROM job${where.sql}`).bind(...where.params),
		]);
		const ids = (page!.results as { id: string }[]).map((row) => row.id);
		return { ids, remaining: Math.max(0, ((total!.results[0] as { total: number } | undefined)?.total ?? 0) - ids.length) };
	}

	async stats(): Promise<JobStatsRow> {
		const { results: rows } = await this.#db
			.prepare(`SELECT state, count(*) AS count FROM job GROUP BY state`)
			.all<{ state: string; count: number }>();
		const oldest = await this.#db
			.prepare(`SELECT min(created_at) AS created_at FROM job WHERE state = ?`)
			.bind('SCHEDULED')
			.first<{ created_at: number | null }>();
		return { byState: Object.fromEntries(rows.map((r) => [r.state, r.count])), oldestScheduledAt: oldest?.created_at ?? null };
	}

	async find(id: string): Promise<Job | null> {
		const found = await this.#db
			.prepare(`SELECT ${READ_MODEL_COLUMNS.job.map((column) => `"${column}"`).join(', ')} FROM job WHERE id = ? LIMIT 1`)
			.bind(id)
			.first<StoredJob>();
		if (!found) return null;
		// 返却列を明示, スプレッドでは内部列(seq)も露出
		const job: Omit<Job, 'attemptsLog'> = {
			id: found.id,
			binding: found.binding,
			state: found.state,
			priority: found.priority,
			attempts: found.attempts,
			maxAttempts: found.max_attempts,
			concurrencyKey: found.concurrency_key,
			uniqueKey: found.unique_key,
			guarantee: found.guarantee,
			createdAt: found.created_at,
			updatedAt: found.updated_at,
			dispatchedAt: found.dispatched_at,
			runAfter: found.run_after,
			expiresAt: found.expires_at,
			cancelRequestedAt: found.cancel_requested_at,
			progress: found.progress,
			traceparent: found.traceparent,
			logs: parseJson<JobLogEntry>(found.logs),
			payload: found.payload,
			result: found.result,
			runId: found.run_id,
			nodeId: found.node_id,
		};
		return { ...job, attemptsLog: attemptsOf(job, parseAttempts(found.attempts_log)) };
	}
}
