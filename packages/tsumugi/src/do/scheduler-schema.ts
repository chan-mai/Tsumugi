import { ensureColumns } from './columns.js';

/** 全scheduleの状態を1テーブルに保持, 定義はコード側(ADR-0040) */
const SCHEDULER_SCHEMA = [
	`CREATE TABLE IF NOT EXISTS schedule (
		name TEXT PRIMARY KEY,
		kind TEXT NOT NULL,
		target TEXT NOT NULL,
		every_ms INTEGER,
		cron TEXT,
		time_zone TEXT NOT NULL DEFAULT 'UTC',
		overlap TEXT NOT NULL,
		paused INTEGER NOT NULL DEFAULT 0,
		next_occurrence_at INTEGER NOT NULL,
		last_occurrence_at INTEGER,
		-- 予定との差で遅延観測
		last_fired_at INTEGER,
		last_job_id TEXT,
		last_run_id TEXT,
		last_skipped_at INTEGER,
		skipped_count INTEGER NOT NULL DEFAULT 0,
		last_error TEXT,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS schedule_next ON schedule (next_occurrence_at)`,
	`CREATE TABLE IF NOT EXISTS setting (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	)`,
] as const;

export function applySchedulerSchema(sql: SqlStorage): void {
	// 旧列名の既存DO, 索引も追従
	const existing = new Set(
		sql
			.exec<{ name: string }>(`SELECT name FROM pragma_table_info('schedule')`)
			.toArray()
			.map((row) => row.name),
	);
	for (const [from, to] of [
		['next_run_at', 'next_occurrence_at'],
		['last_run_at', 'last_occurrence_at'],
	] as const) {
		if (existing.has(from)) sql.exec(`ALTER TABLE schedule RENAME COLUMN ${from} TO ${to}`);
	}
	for (const statement of SCHEDULER_SCHEMA) sql.exec(statement);
	const added = ensureColumns(sql, 'schedule', [
		['time_zone', "TEXT NOT NULL DEFAULT 'UTC'"],
		['paused', 'INTEGER NOT NULL DEFAULT 0'],
	]);
	// NULL許容で作成済みの既存列への対処
	if (!added.has('time_zone')) sql.exec(`UPDATE schedule SET time_zone = 'UTC' WHERE time_zone IS NULL`);
}

export type ScheduleRow = {
	name: string;
	kind: string;
	target: string;
	every_ms: number | null;
	cron: string | null;
	time_zone: string;
	overlap: string;
	paused: number;
	next_occurrence_at: number;
	last_occurrence_at: number | null;
	last_fired_at: number | null;
	last_job_id: string | null;
	last_run_id: string | null;
	last_skipped_at: number | null;
	skipped_count: number;
	last_error: string | null;
	created_at: number;
	updated_at: number;
};
