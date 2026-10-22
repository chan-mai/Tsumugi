import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** 次回時刻と直近の観測のみ保持, 定義はコード側(ADR-0040) */
export const schedule = sqliteTable(
	'schedule',
	{
		name: text('name').primaryKey(),
		kind: text('kind').notNull(),
		target: text('target').notNull(),
		everyMs: integer('every_ms'),
		cron: text('cron'),
		timeZone: text('time_zone').notNull().default('UTC'),
		overlap: text('overlap').notNull(),
		paused: integer('paused').notNull().default(0),
		nextRunAt: integer('next_run_at').notNull(),
		lastRunAt: integer('last_run_at'),
		// 予定との差で遅延観測
		lastFiredAt: integer('last_fired_at'),
		lastJobId: text('last_job_id'),
		lastRunId: text('last_run_id'),
		lastSkippedAt: integer('last_skipped_at'),
		skippedCount: integer('skipped_count').notNull().default(0),
		lastError: text('last_error'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
	},
	(t) => [index('schedule_next').on(t.nextRunAt)],
);

export const schedulerSetting = sqliteTable('setting', {
	key: text('key').primaryKey(),
	value: text('value').notNull(),
});

export type ScheduleRecord = typeof schedule.$inferSelect;
