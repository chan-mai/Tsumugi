import { ensureColumns } from './columns.js';

/**
 * run 1件につき1インスタンス, `run`は常に1行(ADR-0029)
 * 終端runも投影完了まで残存, 保持期間後にDOごと削除(ADR-0034)
 */
const RUN_SCHEMA = [
	`CREATE TABLE IF NOT EXISTS run (
		id TEXT PRIMARY KEY,
		flow TEXT NOT NULL,
		state TEXT NOT NULL,
		input TEXT NOT NULL,
		-- 開始時固定, 定義変更の影響なし(ADR-0030)
		shape TEXT NOT NULL,
		cancelling INTEGER NOT NULL DEFAULT 0,
		parent_run_id TEXT,
		parent_node_id TEXT,
		depth INTEGER NOT NULL DEFAULT 0,
		parent_notified INTEGER NOT NULL DEFAULT 0,
		-- 再開時のdeadline_at再計算用(ADR-0039)
		deadline_ms INTEGER,
		deadline_at INTEGER,
		expired INTEGER NOT NULL DEFAULT 0,
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
		trigger TEXT NOT NULL DEFAULT 'success',
		payload TEXT,
		options TEXT,
		job_id TEXT,
		subflow TEXT,
		child_run_id TEXT,
		result TEXT,
		error TEXT,
		seq INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS node_parent ON node (parent)`,
	`CREATE INDEX IF NOT EXISTS node_state ON node (state)`,
	// 進行判断の毎tick全件順次読み取り用
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
	ensureColumns(sql, 'run', [
		['parent_run_id', 'TEXT'],
		['parent_node_id', 'TEXT'],
		['depth', 'INTEGER NOT NULL DEFAULT 0'],
		['parent_notified', 'INTEGER NOT NULL DEFAULT 0'],
		['deadline_ms', 'INTEGER'],
		['deadline_at', 'INTEGER'],
		['expired', 'INTEGER NOT NULL DEFAULT 0'],
	]);
	ensureColumns(sql, 'node', [
		['trigger', "TEXT NOT NULL DEFAULT 'success'"],
		['subflow', 'TEXT'],
		['child_run_id', 'TEXT'],
	]);
}

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
	deadline_ms: number | null;
	deadline_at: number | null;
	expired: number;
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
	trigger: string;
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
