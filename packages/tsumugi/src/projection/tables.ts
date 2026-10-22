import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** DDLは`migrations/`のSQL, ここは型とクエリ用の定義 */
export const job = sqliteTable(
	'job',
	{
		id: text('id').primaryKey(),
		// 投影元アウトボックス連番, 古い投影での上書き防止
		seq: integer('seq').notNull(),
		binding: text('binding').notNull(),
		state: text('state').notNull(),
		priority: integer('priority').notNull(),
		attempts: integer('attempts').notNull(),
		maxAttempts: integer('max_attempts').notNull(),
		concurrencyKey: text('concurrency_key'),
		uniqueKey: text('unique_key'),
		guarantee: text('guarantee').notNull(),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		dispatchedAt: integer('dispatched_at'),
		/** SCHEDULEDの実行可能時刻, 後から変更可能で投影対象 */
		runAfter: integer('run_after'),
		/** 実行開始期限, 経過後は非実行でCANCELLED */
		expiresAt: integer('expires_at'),
		cancelRequestedAt: integer('cancel_requested_at'),
		/** 0以上1以下 */
		progress: real('progress'),
		payload: text('payload').notNull(),
		result: text('result'),
		traceparent: text('traceparent'),
		runId: text('run_id'),
		nodeId: text('node_id'),
		attemptsLog: text('attempts_log'),
		logs: text('logs'),
	},
	(t) => [
		index('job_state').on(t.state, t.updatedAt),
		index('job_binding').on(t.binding, t.updatedAt),
		index('job_created').on(t.createdAt),
		// 障害調査のキー検索用, 索引無しは全表走査
		index('job_unique_key').on(t.uniqueKey, t.updatedAt),
		index('job_concurrency_key').on(t.concurrencyKey, t.updatedAt),
	],
);
