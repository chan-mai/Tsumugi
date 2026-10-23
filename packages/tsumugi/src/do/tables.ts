import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { TERMINAL_INDEX_WHERE } from './schema.js';

/**
 * 稼働中ジョブの正データ(ADR-0002)
 * 終端ジョブも保持期間経過まで残存, sweepで削除
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
		// 実行開始期限, 経過後は実行せず終了
		expiresAt: integer('expires_at'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		dispatchedAt: integer('dispatched_at'),
		heartbeatAt: integer('heartbeat_at'),
		// 0以上1以下
		progress: real('progress'),
		payload: text('payload').notNull(),
		result: text('result'),
		traceparent: text('traceparent'),
		cancelRequestedAt: integer('cancel_requested_at'),
		// DAGノード投入時の宛先(ADR-0015)
		runId: text('run_id'),
		nodeId: text('node_id'),
	},
	(t) => [
		// tickの実行可能ジョブ抽出, ORDER BYもインデックスで解決(#104)
		index('job_due').on(t.state, t.runAfter, t.id),
		// sweep次回時刻の状態別MIN取得用
		index('job_terminal').on(t.state, t.updatedAt).where(sql.raw(TERMINAL_INDEX_WHERE)),
	],
);

/** 重複排除キー(ADR-0021 / ADR-0022), KVに条件付き書き込み無くDO内配置 */
export const uniqueKey = sqliteTable(
	'unique_key',
	{
		key: text('key').primaryKey(),
		jobId: text('job_id').notNull(),
		expiresAt: integer('expires_at').notNull(),
	},
	(t) => [index('unique_key_expiry').on(t.expiresAt)],
);

/** binding単位ポリシー, tickの同期読み取り用 */
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

/** ジョブ行に無い失敗履歴の調査用(ADR-0028) */
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

export const jobLog = sqliteTable(
	'job_log',
	{
		seq: integer('seq').primaryKey({ autoIncrement: true }),
		jobId: text('job_id').notNull(),
		attempt: integer('attempt').notNull(),
		timestamp: integer('timestamp').notNull(),
		message: text('message').notNull(),
	},
	(t) => [index('job_log_job').on(t.jobId, t.seq)],
);

/** 失敗通知待ち(#30), run_notifyと宛先/対象が別で別表 */
export const failureNotify = sqliteTable('failure_notify', {
	seq: integer('seq').primaryKey({ autoIncrement: true }),
	jobId: text('job_id').notNull(),
	payload: text('payload').notNull(),
});

/** 終端通知待ち(#96), failure_notifyと宛先/対象が別で別表 */
export const settledNotify = sqliteTable('settled_notify', {
	seq: integer('seq').primaryKey({ autoIncrement: true }),
	jobId: text('job_id').notNull(),
	payload: text('payload').notNull(),
});

/** Run DO通知待ち(ADR-0031), outboxと宛先/集約単位が別で別表 */
export const runNotify = sqliteTable(
	'run_notify',
	{
		seq: integer('seq').primaryKey({ autoIncrement: true }),
		runId: text('run_id').notNull(),
		event: text('event').notNull(),
	},
	(t) => [index('run_notify_run').on(t.runId)],
);

/** D1投影待ち(ADR-0008), snapshotはUPSERT内容, 書き込み成功まで保持 */
export const outbox = sqliteTable('outbox', {
	seq: integer('seq').primaryKey({ autoIncrement: true }),
	jobId: text('job_id').notNull(),
	snapshot: text('snapshot').notNull(),
});
