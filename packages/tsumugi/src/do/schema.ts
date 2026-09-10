/**
 * Job DOのSQLiteスキーマ
 *
 * 稼働中ジョブについて正となるデータ(ADR-0002)
 * 終端に達したジョブもアウトボックスの投影が済むまでは残り、sweepで削除
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
		-- 実行開始の期限, 経過後は実行せず終了
		expires_at INTEGER,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		dispatched_at INTEGER,
		-- performerからの最後の生存報告, reaperの無応答判定の起点
		heartbeat_at INTEGER,
		-- 実行中の進捗, 0以上1以下
		progress REAL,
		payload TEXT NOT NULL,
		-- performの戻り値, 成功時にJSON文字列で入る(#9), 上限超過や非直列化はnull
		result TEXT,
		-- v2のDAG用の予約列(ADR-0015), 後からのスキーマ変更が不要なよう最初から配置
		run_id TEXT,
		node_id TEXT
	)`,
	// tickが最初に実行するクエリ, 実行可能なジョブの抽出に使用
	`CREATE INDEX IF NOT EXISTS job_active ON job (state, run_after)`,
	`CREATE INDEX IF NOT EXISTS job_concurrency_key ON job (concurrency_key, state)`,
	`CREATE INDEX IF NOT EXISTS job_run ON job (run_id, node_id)`,
	// 重複排除(ADR-0021 / ADR-0022), ジョブ本体ではなくキーだけを一定期間保持
	// KVには条件付き書き込みが無く「無ければ挿入」の不可分な実行が不能, DO内に配置
	`CREATE TABLE IF NOT EXISTS unique_key (
		key TEXT PRIMARY KEY,
		job_id TEXT NOT NULL,
		expires_at INTEGER NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS unique_key_expiry ON unique_key (expires_at)`,
	// binding単位のポリシー, tickの同期読み取り用にSQLiteへ配置
	`CREATE TABLE IF NOT EXISTS setting (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	)`,
	// キー別トークンバケット(ADR-0045), tokens上限の行は保存対象外
	`CREATE TABLE IF NOT EXISTS key_bucket (
		key TEXT PRIMARY KEY,
		tokens REAL NOT NULL,
		refilled_at INTEGER NOT NULL
	)`,
	// 上限到達行の削除用
	`CREATE INDEX IF NOT EXISTS key_bucket_refilled ON key_bucket (refilled_at)`,
	// 試行ごとの記録(ADR-0028), 失敗の事後調査に必要
	// ジョブ行は最新の状態しか持たず、何回目がいつ何で失敗したかは残らない
	`CREATE TABLE IF NOT EXISTS attempt (
		job_id TEXT NOT NULL,
		attempt INTEGER NOT NULL,
		state TEXT NOT NULL,
		started_at INTEGER,
		finished_at INTEGER NOT NULL,
		error TEXT,
		PRIMARY KEY (job_id, attempt)
	)`,
	// Run DOへの通知待ち(ADR-0031), 送信の成功まで削除せず中断しても次のtickで追いつく
	// D1への投影とは宛先もまとめ方も別で表も分離, 共用は片方の失敗がもう片方を停止
	`CREATE TABLE IF NOT EXISTS run_notify (
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		run_id TEXT NOT NULL,
		event TEXT NOT NULL
	)`,
	// 失敗の通知待ち(#30), 投入の成功まで削除せず中断しても次のtickで追いつく
	// Run DOへの通知と分離, 宛先も対象も別で共用は片方の失敗がもう片方を停止
	`CREATE TABLE IF NOT EXISTS failure_notify (
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		job_id TEXT NOT NULL,
		payload TEXT NOT NULL
	)`,
	// D1への投影待ち(ADR-0008), snapshotはD1へUPSERTする内容そのもの
	// D1書き込みの成功まで削除せず、失敗時もカーソルが進まず次回で追いつく
	`CREATE TABLE IF NOT EXISTS outbox (
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		job_id TEXT NOT NULL,
		snapshot TEXT NOT NULL
	)`,
] as const;

export function applySchema(sql: SqlStorage): void {
	for (const statement of SCHEMA) sql.exec(statement);
	// CREATE TABLE IF NOT EXISTSは既存テーブルを変更しない, 後から追加した列を既存DOへ反映(#9)
	ensureColumn(sql, 'job', 'result', 'TEXT');
	ensureColumn(sql, 'job', 'heartbeat_at', 'INTEGER');
	ensureColumn(sql, 'job', 'progress', 'REAL');
	ensureColumn(sql, 'job', 'expires_at', 'INTEGER');
	sql.exec(`CREATE INDEX IF NOT EXISTS run_notify_run ON run_notify (run_id)`);
}

/** 既存の表に無い列の追加, 冪等化のため先に有無を確認 */
function ensureColumn(sql: SqlStorage, table: string, column: string, type: string): void {
	const exists = sql
		.exec<{ name: string }>(`SELECT name FROM pragma_table_info(?)`, table)
		.toArray()
		.some((row) => row.name === column);
	if (!exists) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

/** 試行1回ぶんの記録 */
export type AttemptRow = {
	job_id: string;
	attempt: number;
	state: string;
	started_at: number | null;
	finished_at: number;
	error: string | null;
};

/** SQLiteの行そのまま, 射影はrepo.tsが担当 */
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
	expires_at: number | null;
	created_at: number;
	updated_at: number;
	dispatched_at: number | null;
	heartbeat_at: number | null;
	progress: number | null;
	payload: string;
	result: string | null;
	run_id: string | null;
	node_id: string | null;
};
