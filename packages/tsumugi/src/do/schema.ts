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
	// 重複排除(ADR-0021 / ADR-0022),ジョブ本体ではなくキーだけを一定期間残す
	// KVには条件付き書き込みが無く「無ければ入れる」を不可分に実行できないためDO内に置く
	`CREATE TABLE IF NOT EXISTS unique_key (
		key TEXT PRIMARY KEY,
		job_id TEXT NOT NULL,
		expires_at INTEGER NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS unique_key_expiry ON unique_key (expires_at)`,
	// binding単位のポリシー, tickが同期で読めるようSQLiteに置く
	`CREATE TABLE IF NOT EXISTS setting (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	)`,
	// D1への投影待ち(ADR-0008), snapshotはD1へUPSERTする内容そのもの
	// D1書き込みが成功するまで削除しないので,失敗してもカーソルが進まず次回で追いつく
	`CREATE TABLE IF NOT EXISTS outbox (
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		job_id TEXT NOT NULL,
		snapshot TEXT NOT NULL
	)`,
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
