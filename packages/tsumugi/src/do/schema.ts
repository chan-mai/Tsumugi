/**
 * Job DOのSQLiteスキーマ
 *
 * 稼働中ジョブの真実の源(ADR-0002)
 * 終端に達したジョブもアウトボックスの投影が済むまでは残り, sweepで削除される
 */
export const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS job (
		id TEXT PRIMARY KEY,
		binding TEXT NOT NULL,
		state TEXT NOT NULL,
		priority INTEGER NOT NULL DEFAULT 0,
		attempts INTEGER NOT NULL DEFAULT 0,
		max_attempts INTEGER NOT NULL,
		concurrency_key TEXT,
		unique_key TEXT,
		guarantee TEXT NOT NULL,
		timeout_ms INTEGER NOT NULL,
		backoff TEXT NOT NULL,
		run_after INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		dispatched_at INTEGER,
		payload TEXT NOT NULL,
		-- v2のDAG用の予約席(ADR-0015),後からスキーマを書き換えずに済むよう最初から置く
		run_id TEXT,
		node_id TEXT
	)`,
	// tickが最初に引くクエリ,実行可能なジョブの絞り込みに使う
	`CREATE INDEX IF NOT EXISTS job_active ON job (state, run_after)`,
	`CREATE INDEX IF NOT EXISTS job_concurrency_key ON job (concurrency_key, state)`,
	`CREATE INDEX IF NOT EXISTS job_run ON job (run_id, node_id)`,
] as const;

export function applySchema(sql: SqlStorage): void {
	for (const statement of SCHEMA) sql.exec(statement);
}

/** SQLiteの行そのまま,射影はrepo.tsが担う */
export type JobRow = {
	id: string;
	binding: string;
	state: string;
	priority: number;
	attempts: number;
	max_attempts: number;
	concurrency_key: string | null;
	unique_key: string | null;
	guarantee: string;
	timeout_ms: number;
	backoff: string;
	run_after: number;
	created_at: number;
	updated_at: number;
	dispatched_at: number | null;
	payload: string;
	run_id: string | null;
	node_id: string | null;
};
