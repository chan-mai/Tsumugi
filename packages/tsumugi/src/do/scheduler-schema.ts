/**
 * Scheduler DOのSQLiteスキーマ(ADR-0040)
 *
 * インスタンスは1つで, 全scheduleの状態を1枚の表に持つ
 * 定義そのものはコードにあり, ここには次回時刻と直近の観測だけを置く
 */
export const SCHEDULER_SCHEMA = [
	`CREATE TABLE IF NOT EXISTS schedule (
		name TEXT PRIMARY KEY,
		-- 'job' | 'flow', 発火経路とID形式の分岐
		kind TEXT NOT NULL,
		-- binding名またはflow名
		target TEXT NOT NULL,
		-- 固定間隔(ms), cronと排他
		every_ms INTEGER,
		cron TEXT,
		-- 'skip' | 'overlap', 前回未了時の扱い
		overlap TEXT NOT NULL,
		next_run_at INTEGER NOT NULL,
		-- 直近発火の予定時刻
		last_run_at INTEGER,
		-- 実際に発火した時刻, 予定との差で遅延を観測する
		last_fired_at INTEGER,
		-- skip判定の照会先, 画面から詳細へ辿る足がかりでもある
		last_job_id TEXT,
		last_run_id TEXT,
		last_skipped_at INTEGER,
		skipped_count INTEGER NOT NULL DEFAULT 0,
		-- 写像関数や発火の失敗の理由
		last_error TEXT,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS schedule_next ON schedule (next_run_at)`,
	`CREATE TABLE IF NOT EXISTS setting (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	)`,
] as const;

export function applySchedulerSchema(sql: SqlStorage): void {
	for (const statement of SCHEDULER_SCHEMA) sql.exec(statement);
}

/** SQLiteの行そのまま, 射影はscheduler-repo.tsが担う */
export type ScheduleRow = {
	name: string;
	kind: string;
	target: string;
	every_ms: number | null;
	cron: string | null;
	overlap: string;
	next_run_at: number;
	last_run_at: number | null;
	last_fired_at: number | null;
	last_job_id: string | null;
	last_run_id: string | null;
	last_skipped_at: number | null;
	skipped_count: number;
	last_error: string | null;
	created_at: number;
	updated_at: number;
};
