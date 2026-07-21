import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * D1の読み取りモデル(ADR-0008)
 *
 * ダッシュボードとREST APIが読む投影先で, 数秒遅れる
 * DOのSQLiteとは列が異なる, こちらは`seq`と`attempts_log`を持ち実行制御用の列を持たない
 * DDLは`migrations/`のSQLが持つ, ここは型とクエリのための定義
 */
export const job = sqliteTable(
	'job',
	{
		id: text('id').primaryKey(),
		// 投影元のアウトボックス連番, 古い投影が新しい状態を上書きするのを弾く
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
		payload: text('payload').notNull(),
		runId: text('run_id'),
		nodeId: text('node_id'),
		attemptsLog: text('attempts_log'),
	},
	(t) => [
		index('job_state').on(t.state, t.updatedAt),
		index('job_binding').on(t.binding, t.updatedAt),
		index('job_created').on(t.createdAt),
	],
);

export type ReadModelJob = typeof job.$inferSelect;
