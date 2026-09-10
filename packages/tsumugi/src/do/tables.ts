import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Job DOのSQLiteスキーマ
 *
 * 稼働中ジョブについて正となるデータ(ADR-0002)
 * 終端に達したジョブもアウトボックスの投影が済むまでは残り、sweepで削除
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
		// 実行開始の期限, 経過後は実行せず終了
		expiresAt: integer('expires_at'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		dispatchedAt: integer('dispatched_at'),
		/** performerからの最後の生存報告, reaperの無応答判定の起点 */
		heartbeatAt: integer('heartbeat_at'),
		/** 実行中の進捗, 0以上1以下 */
		progress: real('progress'),
		payload: text('payload').notNull(),
		// performの戻り値, 成功時にJSON文字列で入る(#9)
		result: text('result'),
		// v2のDAG用の予約列(ADR-0015), 後からのスキーマ変更が不要なよう最初から配置
		runId: text('run_id'),
		nodeId: text('node_id'),
	},
	(t) => [
		// tickが最初に実行するクエリ, 実行可能なジョブの抽出に使用
		index('job_active').on(t.state, t.runAfter),
		index('job_concurrency_key').on(t.concurrencyKey, t.state),
		index('job_run').on(t.runId, t.nodeId),
	],
);

/**
 * 重複排除(ADR-0021 / ADR-0022), ジョブ本体ではなくキーだけを一定期間保持
 * KVには条件付き書き込みが無く「無ければ挿入」の不可分な実行が不能, DO内に配置
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

/** binding単位のポリシー, tickの同期読み取り用にSQLiteへ配置 */
export const setting = sqliteTable('setting', {
	key: text('key').primaryKey(),
	value: text('value').notNull(),
});

/** キー別トークンバケット(ADR-0045), tokens上限の行は保存対象外 */
export const keyBucket = sqliteTable(
	'key_bucket',
	{
		key: text('key').primaryKey(),
		tokens: real('tokens').notNull(),
		refilledAt: integer('refilled_at').notNull(),
	},
	(t) => [index('key_bucket_refilled').on(t.refilledAt)],
);

/**
 * 試行ごとの記録(ADR-0028), 失敗の事後調査に必要
 * ジョブ行は最新の状態しか持たず、何回目がいつ何で失敗したかは残らない
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
 * D1書き込みの成功まで削除せず、失敗時もカーソルが進まず次回で追いつく
 */
/**
 * Run DOへの通知待ち(ADR-0031)
 * D1への投影とは宛先もまとめ方も別で表も分離
 */
/**
 * 失敗の通知待ち(#30)
 * Run DOへの通知とは宛先も対象も別で表も分離
 */
export const failureNotify = sqliteTable('failure_notify', {
	seq: integer('seq').primaryKey({ autoIncrement: true }),
	jobId: text('job_id').notNull(),
	payload: text('payload').notNull(),
});

export const runNotify = sqliteTable(
	'run_notify',
	{
		seq: integer('seq').primaryKey({ autoIncrement: true }),
		runId: text('run_id').notNull(),
		event: text('event').notNull(),
	},
	(t) => [index('run_notify_run').on(t.runId)],
);

export const outbox = sqliteTable('outbox', {
	seq: integer('seq').primaryKey({ autoIncrement: true }),
	jobId: text('job_id').notNull(),
	snapshot: text('snapshot').notNull(),
});

export type JobRecord = typeof job.$inferSelect;
export type AttemptRecord = typeof attempt.$inferSelect;
export type OutboxRecord = typeof outbox.$inferSelect;
