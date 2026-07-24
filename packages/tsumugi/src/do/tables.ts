import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Job DOのSQLiteスキーマ
 *
 * 稼働中ジョブについて正となるデータ(ADR-0002)
 * 終端に達したジョブもアウトボックスの投影が済むまでは残り, sweepで削除される
 */
export const job = sqliteTable(
	'job',
	{
		id: text('id').primaryKey(),
		binding: text('binding').notNull(),
		state: text('state').notNull(),
		priority: integer('priority').notNull().default(0),
		attempts: integer('attempts').notNull().default(0),
		maxAttempts: integer('max_attempts').notNull(),
		concurrencyKey: text('concurrency_key'),
		uniqueKey: text('unique_key'),
		guarantee: text('guarantee').notNull(),
		timeoutMs: integer('timeout_ms').notNull(),
		backoff: text('backoff').notNull(),
		runAfter: integer('run_after').notNull(),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		dispatchedAt: integer('dispatched_at'),
		payload: text('payload').notNull(),
		// performの戻り値, 成功時にJSON文字列で入る(#9)
		result: text('result'),
		// v2のDAG用の予約席(ADR-0015),後からスキーマを書き換えずに済むよう最初から置く
		runId: text('run_id'),
		nodeId: text('node_id'),
	},
	(t) => [
		// tickが最初に引くクエリ,実行可能なジョブの絞り込みに使う
		index('job_active').on(t.state, t.runAfter),
		index('job_concurrency_key').on(t.concurrencyKey, t.state),
		index('job_run').on(t.runId, t.nodeId),
	],
);

/**
 * 重複排除(ADR-0021 / ADR-0022), ジョブ本体ではなくキーだけを一定期間残す
 * KVには条件付き書き込みが無く「無ければ入れる」を不可分に実行できないためDO内に置く
 */
export const uniqueKey = sqliteTable(
	'unique_key',
	{
		key: text('key').primaryKey(),
		jobId: text('job_id').notNull(),
		expiresAt: integer('expires_at').notNull(),
	},
	(t) => [index('unique_key_expiry').on(t.expiresAt)],
);

/** binding単位のポリシー, tickが同期で読めるようSQLiteに置く */
export const setting = sqliteTable('setting', {
	key: text('key').primaryKey(),
	value: text('value').notNull(),
});

/**
 * 試行ごとの記録(ADR-0028), 失敗の事後調査に要る
 * ジョブ行は最新の状態しか持たず,何回目がいつ何で落ちたかは残らない
 */
export const attempt = sqliteTable(
	'attempt',
	{
		jobId: text('job_id').notNull(),
		attempt: integer('attempt').notNull(),
		state: text('state').notNull(),
		startedAt: integer('started_at'),
		finishedAt: integer('finished_at').notNull(),
		error: text('error'),
	},
	(t) => [primaryKey({ columns: [t.jobId, t.attempt] })],
);

/**
 * D1への投影待ち(ADR-0008), snapshotはD1へUPSERTする内容そのもの
 * D1書き込みが成功するまで削除しないので,失敗してもカーソルが進まず次回で追いつく
 */
export const outbox = sqliteTable('outbox', {
	seq: integer('seq').primaryKey({ autoIncrement: true }),
	jobId: text('job_id').notNull(),
	snapshot: text('snapshot').notNull(),
});

export type JobRecord = typeof job.$inferSelect;
export type AttemptRecord = typeof attempt.$inferSelect;
export type OutboxRecord = typeof outbox.$inferSelect;
