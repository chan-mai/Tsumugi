import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Scheduler DOのSQLiteスキーマ(ADR-0040)
 *
 * 定義はコードにあり, ここには次回時刻と直近の観測だけを置く
 */
export const schedule = sqliteTable(
	'schedule',
	{
		name: text('name').primaryKey(),
		/** 'job' | 'flow', 発火経路とID形式の分岐 */
		kind: text('kind').notNull(),
		/** binding名またはflow名 */
		target: text('target').notNull(),
		/** 固定間隔(ms), cronと排他 */
		everyMs: integer('every_ms'),
		cron: text('cron'),
		/** 'skip' | 'overlap', 前回未了時の扱い */
		overlap: text('overlap').notNull(),
		nextRunAt: integer('next_run_at').notNull(),
		/** 直近発火の予定時刻 */
		lastRunAt: integer('last_run_at'),
		/** 実際に発火した時刻, 予定との差で遅延を観測する */
		lastFiredAt: integer('last_fired_at'),
		/** skip判定の照会先, 画面から詳細へ辿る足がかりでもある */
		lastJobId: text('last_job_id'),
		lastRunId: text('last_run_id'),
		lastSkippedAt: integer('last_skipped_at'),
		skippedCount: integer('skipped_count').notNull().default(0),
		/** 写像関数や発火の失敗の理由 */
		lastError: text('last_error'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
	},
	(t) => [index('schedule_next').on(t.nextRunAt)],
);

/** 正規化した定義のfingerprintを持つ, 一致すれば突き合わせを省ける */
export const schedulerSetting = sqliteTable('setting', {
	key: text('key').primaryKey(),
	value: text('value').notNull(),
});

export type ScheduleRecord = typeof schedule.$inferSelect;
