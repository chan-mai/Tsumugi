import { ensureColumns } from './columns.js';

/** job_terminal部分索引条件 */
export const TERMINAL_INDEX_WHERE = `state IN ('COMPLETED', 'CANCELLED', 'FAILED', 'STALLED')`;

/**
 * 稼働中ジョブの正データ(ADR-0002)
 * 終端ジョブも保持期間経過まで残存, sweepで削除
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
		-- 実行開始期限, 経過後は実行せず終了
		expires_at INTEGER,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		dispatched_at INTEGER,
		heartbeat_at INTEGER,
		-- 0以上1以下
		progress REAL,
		payload TEXT NOT NULL,
		-- performの戻り値JSON(#9), 上限超過/非直列化はnull
		result TEXT,
		traceparent TEXT,
		cancel_requested_at INTEGER,
		-- DAGノード投入時の宛先(ADR-0015)
		run_id TEXT,
		node_id TEXT
	)`,
	// tickの実行可能ジョブ抽出, ORDER BYもインデックスで解決(#104)
	`CREATE INDEX IF NOT EXISTS job_due ON job (state, run_after, id)`,
	// sweep次回時刻の状態別MIN取得用, 稼働中の遷移で更新不要
	`CREATE INDEX IF NOT EXISTS job_terminal ON job (state, updated_at) WHERE ${TERMINAL_INDEX_WHERE}`,
	// 重複排除キー(ADR-0021 / ADR-0022), KVに条件付き書き込み無くDO内配置
	`CREATE TABLE IF NOT EXISTS unique_key (
		key TEXT PRIMARY KEY,
		job_id TEXT NOT NULL,
		expires_at INTEGER NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS unique_key_expiry ON unique_key (expires_at)`,
	// binding単位ポリシー, tickの同期読み取り用
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
	// ジョブ行に無い失敗履歴の調査用(ADR-0028)
	`CREATE TABLE IF NOT EXISTS attempt (
		job_id TEXT NOT NULL,
		attempt INTEGER NOT NULL,
		state TEXT NOT NULL,
		started_at INTEGER,
		finished_at INTEGER NOT NULL,
		error TEXT,
		PRIMARY KEY (job_id, attempt)
	)`,
	`CREATE TABLE IF NOT EXISTS job_log (
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		job_id TEXT NOT NULL,
		attempt INTEGER NOT NULL,
		timestamp INTEGER NOT NULL,
		message TEXT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS job_log_job ON job_log (job_id, seq)`,
	// Run DO通知待ち(ADR-0031), 送信成功まで保持
	// outboxと別表, 共用時は片方の失敗で両方停止
	`CREATE TABLE IF NOT EXISTS run_notify (
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		run_id TEXT NOT NULL,
		event TEXT NOT NULL
	)`,
	// 失敗通知待ち(#30), 投入成功まで保持
	// run_notifyと別表, 共用時は片方の失敗で両方停止
	`CREATE TABLE IF NOT EXISTS failure_notify (
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		job_id TEXT NOT NULL,
		payload TEXT NOT NULL
	)`,
	// 終端通知待ち(#96), 投入成功まで保持
	// failure_notifyと別表, 共用時は片方の失敗で両方停止
	`CREATE TABLE IF NOT EXISTS settled_notify (
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		job_id TEXT NOT NULL,
		payload TEXT NOT NULL
	)`,
	// D1投影待ち(ADR-0008), snapshotはUPSERT内容, 書き込み成功まで保持
	`CREATE TABLE IF NOT EXISTS outbox (
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		job_id TEXT NOT NULL,
		snapshot TEXT NOT NULL
	)`,
] as const;

export function applySchema(sql: SqlStorage): void {
	// 既存DOの全状態対象の旧索引, 直後のCREATEで部分索引へ
	const terminal = sql.exec<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'job_terminal'`).toArray()[0];
	if (terminal && !/\bWHERE\b/i.test(terminal.sql)) sql.exec(`DROP INDEX job_terminal`);
	for (const statement of SCHEMA) sql.exec(statement);
	// 既存DOへの追加列反映(#9)
	ensureColumns(sql, 'job', [
		['result', 'TEXT'],
		['heartbeat_at', 'INTEGER'],
		['progress', 'REAL'],
		['expires_at', 'INTEGER'],
		['traceparent', 'TEXT'],
		['cancel_requested_at', 'INTEGER'],
	]);
	sql.exec(`CREATE INDEX IF NOT EXISTS run_notify_run ON run_notify (run_id)`);
	// 既存DOに残る未使用索引, 書き込みごとに更新
	sql.exec(`DROP INDEX IF EXISTS job_concurrency_key`);
	sql.exec(`DROP INDEX IF EXISTS job_run`);
	// job_dueが先頭列を含み代替
	sql.exec(`DROP INDEX IF EXISTS job_active`);
}

export type AttemptRow = {
	job_id: string;
	attempt: number;
	state: string;
	started_at: number | null;
	finished_at: number;
	error: string | null;
};

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
	traceparent: string | null;
	cancel_requested_at: number | null;
	run_id: string | null;
	node_id: string | null;
};
