import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
		// 投影元のアウトボックス連番, 古い投影による新しい状態の上書きを防止
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
		/** SCHEDULEDが実行可能になる時刻, 後から変更可能で投影対象 */
		runAfter: integer('run_after'),
		/** 実行開始の期限, 経過後は実行されずCANCELLED */
		expiresAt: integer('expires_at'),
		/** 実行中のジョブが報告した進捗, 0以上1以下 */
		progress: real('progress'),
		payload: text('payload').notNull(),
		// performの戻り値, DOのjob.resultをそのまま投影(#9)
		result: text('result'),
		runId: text('run_id'),
		nodeId: text('node_id'),
		attemptsLog: text('attempts_log'),
	},
	(t) => [
		index('job_state').on(t.state, t.updatedAt),
		index('job_binding').on(t.binding, t.updatedAt),
		index('job_created').on(t.createdAt),
		// 障害の調査はキーから入ることが多い, 索引が無いと全表走査
		index('job_unique_key').on(t.uniqueKey, t.updatedAt),
		index('job_concurrency_key').on(t.concurrencyKey, t.updatedAt),
	],
);

export type ReadModelJob = typeof job.$inferSelect;
