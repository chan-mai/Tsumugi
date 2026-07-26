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
		-- subflowとして起動された場合の親, 終端に達した時点で親へ知らせる
		parent_run_id TEXT,
		parent_node_id TEXT,
		-- 入れ子の深さ, 上限を超える起動を弾く
		depth INTEGER NOT NULL DEFAULT 0,
		-- 親へ終端を伝え終えたか, 失敗しても次のtickで再送する
		parent_notified INTEGER NOT NULL DEFAULT 0,
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
		-- subflowノードが起動する子のflow名
		subflow TEXT,
		-- subflowノードが起動した子のrunID
		child_run_id TEXT,
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
	// CREATE TABLE IF NOT EXISTSは既存テーブルを変更しない, 後から足した列を既存DOへ補う
	for (const [table, column, type] of [
		['run', 'parent_run_id', 'TEXT'],
		['run', 'parent_node_id', 'TEXT'],
		['run', 'depth', 'INTEGER NOT NULL DEFAULT 0'],
		['run', 'parent_notified', 'INTEGER NOT NULL DEFAULT 0'],
		['node', 'subflow', 'TEXT'],
		['node', 'child_run_id', 'TEXT'],
	] as const) {
		ensureColumn(sql, table, column, type);
	}
}

/** 既存の表に列が無ければ足す, 冪等にするため先に有無を確かめる */
function ensureColumn(sql: SqlStorage, table: string, column: string, type: string): void {
	const exists = sql
		.exec<{ name: string }>(`SELECT name FROM pragma_table_info(?)`, table)
		.toArray()
		.some((row) => row.name === column);
	if (!exists) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

/** SQLiteの行そのまま, 射影はrun-repo.tsが担う */
export type RunRow = {
	id: string;
	flow: string;
	state: string;
	input: string;
	shape: string;
	cancelling: number;
	parent_run_id: string | null;
	parent_node_id: string | null;
	depth: number;
	parent_notified: number;
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
	subflow: string | null;
	job_id: string | null;
	child_run_id: string | null;
	result: string | null;
	error: string | null;
	seq: number;
	created_at: number;
	updated_at: number;
};
