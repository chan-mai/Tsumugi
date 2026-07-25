/**
 * Run DOのSQLiteスキーマ(ADR-0029)
 *
 * run 1件につき1インスタンスなので`run`は常に1行
 * 終端に達したrunも投影が済むまで残り, 保持期間の経過後にDOごと削除する(ADR-0034)
 */
export const RUN_SCHEMA = [
	`CREATE TABLE IF NOT EXISTS run (
		id TEXT PRIMARY KEY,
		flow TEXT NOT NULL,
		state TEXT NOT NULL,
		input TEXT NOT NULL,
		-- 開始時に固定したグラフの形(ADR-0030)
		shape TEXT NOT NULL,
		cancelling INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS node (
		id TEXT PRIMARY KEY,
		binding TEXT NOT NULL,
		state TEXT NOT NULL,
		container INTEGER NOT NULL DEFAULT 0,
		parent TEXT,
		origin TEXT NOT NULL,
		after TEXT NOT NULL,
		-- 実行時に増えたノードのpayloadと投入設定, 静的ノードはflow定義から作るのでnull
		payload TEXT,
		options TEXT,
		job_id TEXT,
		result TEXT,
		error TEXT,
		seq INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS node_parent ON node (parent)`,
	`CREATE INDEX IF NOT EXISTS node_state ON node (state)`,
	// 進行判断は毎tickで並び順に全件読む, 先頭列がseqの索引が要る
	`CREATE INDEX IF NOT EXISTS node_seq ON node (seq, id)`,
	`CREATE TABLE IF NOT EXISTS run_outbox (
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		kind TEXT NOT NULL,
		target TEXT NOT NULL,
		snapshot TEXT NOT NULL
	)`,
] as const;

export function applyRunSchema(sql: SqlStorage): void {
	for (const statement of RUN_SCHEMA) sql.exec(statement);
}

/** SQLiteの行そのまま, 射影はrun-repo.tsが担う */
export type RunRow = {
	id: string;
	flow: string;
	state: string;
	input: string;
	shape: string;
	cancelling: number;
	created_at: number;
	updated_at: number;
};

export type NodeRow = {
	id: string;
	binding: string;
	state: string;
	container: number;
	parent: string | null;
	origin: string;
	after: string;
	payload: string | null;
	options: string | null;
	job_id: string | null;
	result: string | null;
	error: string | null;
	seq: number;
	created_at: number;
	updated_at: number;
};
