import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Run DOのSQLiteスキーマ(ADR-0029)
 *
 * run 1件につき1インスタンスなので`run`は常に1行
 * 進行中のrunについて正となるデータで, D1の読み取りモデルは投影先(ADR-0008)
 */
export const run = sqliteTable('run', {
	id: text('id').primaryKey(),
	flow: text('flow').notNull(),
	state: text('state').notNull(),
	/** startの入力, 写像関数の第1引数 */
	input: text('input').notNull(),
	/** 開始時に固定したグラフの形, 定義が変わっても走行中のrunは影響を受けない(ADR-0030) */
	shape: text('shape').notNull(),
	/** 取り消しが要求された, 未起動を止めて実行中の終端を待つ */
	cancelling: integer('cancelling').notNull().default(0),
	/** subflowとして起動された場合の親 */
	parentRunId: text('parent_run_id'),
	parentNodeId: text('parent_node_id'),
	/** 入れ子の深さ, 上限を超える起動を弾く */
	depth: integer('depth').notNull().default(0),
	/** 親へ終端を伝え終えたか */
	parentNotified: integer('parent_notified').notNull().default(0),
	/** run全体の期限(ms), 再開時にdeadline_atを引き直す材料(ADR-0039) */
	deadlineMs: integer('deadline_ms'),
	/** 期限の時刻, 超過したrunは打ち切られてFAILEDになる */
	deadlineAt: integer('deadline_at'),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull(),
});

export const node = sqliteTable(
	'node',
	{
		id: text('id').primaryKey(),
		binding: text('binding').notNull(),
		state: text('state').notNull(),
		/** fan-outノード, ジョブを持たず子の展開と集約のみを行う */
		container: integer('container').notNull().default(0),
		/** 実行時に増えたノードの親(ADR-0032) */
		parent: text('parent'),
		origin: text('origin').notNull(),
		/** 依存先のノードIDのJSON配列 */
		after: text('after').notNull(),
		/** 実行時に増えたノードのpayloadと投入設定, 静的ノードはflow定義から作るのでnull */
		payload: text('payload'),
		options: text('options'),
		/** subflowノードが起動する子のflow名 */
		subflow: text('subflow'),
		/** 最後に走ったジョブ, 再開で張り替わる(ADR-0034) */
		jobId: text('job_id'),
		/** subflowノードが起動した子のrunID */
		childRunId: text('child_run_id'),
		/** 後続のpayloadの材料, fan-outノードは集計値が入る(ADR-0035) */
		result: text('result'),
		error: text('error'),
		/** 表示の並び順, 定義順と生成順を保つ */
		seq: integer('seq').notNull(),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
	},
	(t) => [
		index('node_parent').on(t.parent),
		index('node_state').on(t.state),
		// 進行判断は毎tickで並び順に全件読む, 先頭列がseqの索引が要る
		index('node_seq').on(t.seq, t.id),
	],
);

/**
 * D1への投影待ち(ADR-0008)
 * runとnodeを同じ列で運ぶ, 種別ごとに経路を分けると投影の冪等性をもう1つ作ることになる
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
