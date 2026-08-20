import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Run DOのSQLiteスキーマ(ADR-0029)
 *
 * run 1件につき1インスタンスなので`run`は常に1行
 * 進行中のrunについて正となるデータで、D1の読み取りモデルは投影先(ADR-0008)
 */
export const run = sqliteTable('run', {
	id: text('id').primaryKey(),
	flow: text('flow').notNull(),
	state: text('state').notNull(),
	/** startの入力, 写像関数の第1引数 */
	input: text('input').notNull(),
	/** 開始時に固定したグラフの形, 定義が変わっても実行中のrunには影響なし(ADR-0030) */
	shape: text('shape').notNull(),
	/** 取り消しが要求された, 未起動を停止して実行中の終端を待機 */
	cancelling: integer('cancelling').notNull().default(0),
	/** subflowとして起動された場合の親 */
	parentRunId: text('parent_run_id'),
	parentNodeId: text('parent_node_id'),
	/** 入れ子の深さ, 上限を超える起動は拒否 */
	depth: integer('depth').notNull().default(0),
	/** 親へ終端を伝え終えたか */
	parentNotified: integer('parent_notified').notNull().default(0),
	/** run全体の期限(ms), 再開時にdeadline_atを再計算する材料(ADR-0039) */
	deadlineMs: integer('deadline_ms'),
	/** 期限の時刻, 超過したrunは中断されFAILEDへ */
	deadlineAt: integer('deadline_at'),
	/** 超過の印, 設定後の決着はFAILED */
	expired: integer('expired').notNull().default(0),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull(),
});

export const node = sqliteTable(
	'node',
	{
		id: text('id').primaryKey(),
		binding: text('binding').notNull(),
		state: text('state').notNull(),
		/** fan-outノード, ジョブを持たず子の展開と集約のみ */
		container: integer('container').notNull().default(0),
		/** 実行時に増えたノードの親(ADR-0032) */
		parent: text('parent'),
		origin: text('origin').notNull(),
		/** 依存先のノードIDのJSON配列 */
		after: text('after').notNull(),
		/** 依存の成否に対する発火条件(ADR-0041) */
		trigger: text('trigger').notNull().default('success'),
		/** 実行時に増えたノードのpayloadと投入設定, 静的ノードはflow定義由来でnull */
		payload: text('payload'),
		options: text('options'),
		/** subflowノードが起動する子のflow名 */
		subflow: text('subflow'),
		/** 最後に実行したジョブ, 再開で差し替わる(ADR-0034) */
		jobId: text('job_id'),
		/** subflowノードが起動した子のrunID */
		childRunId: text('child_run_id'),
		/** 後続のpayloadの材料, fan-outノードは集計値が入る(ADR-0035) */
		result: text('result'),
		error: text('error'),
		/** 表示の並び順, 定義順と生成順を維持 */
		seq: integer('seq').notNull(),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
	},
	(t) => [
		index('node_parent').on(t.parent),
		index('node_state').on(t.state),
		// 進行判断は毎tickで並び順に全件読む, 先頭列がseqの索引が必要
		index('node_seq').on(t.seq, t.id),
	],
);

/**
 * D1への投影待ち(ADR-0008)
 * runとnodeを同じ列で扱う, 種別ごとの経路分割は投影の冪等性がもう1つ必要
 */
export const runOutbox = sqliteTable('run_outbox', {
	seq: integer('seq').primaryKey({ autoIncrement: true }),
	kind: text('kind').notNull(),
	target: text('target').notNull(),
	snapshot: text('snapshot').notNull(),
});

export type RunRecord = typeof run.$inferSelect;
export type NodeRecord = typeof node.$inferSelect;
export type RunOutboxRecord = typeof runOutbox.$inferSelect;
