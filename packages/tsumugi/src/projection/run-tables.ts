import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Run DO横断の一覧用(ADR-0008 / ADR-0029)
 * DDLは`migrations/`のSQL, ここは型とクエリ用の定義
 */
export const run = sqliteTable(
	'run',
	{
		id: text('id').primaryKey(),
		// 投影元アウトボックス連番, 古い投影での上書き防止
		seq: integer('seq').notNull(),
		flow: text('flow').notNull(),
		state: text('state').notNull(),
		input: text('input').notNull(),
		nodeTotal: integer('node_total').notNull(),
		nodeDone: integer('node_done').notNull(),
		nodeFailed: integer('node_failed').notNull(),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		/** subflow起動時の親 */
		parentRunId: text('parent_run_id'),
		parentNodeId: text('parent_node_id'),
	},
	(t) => [
		index('run_state').on(t.state, t.updatedAt),
		index('run_flow').on(t.flow, t.updatedAt),
		// 既定一覧のフィルタ無しupdated_at降順用
		index('run_updated').on(t.updatedAt, t.id),
	],
);

export const runNode = sqliteTable(
	'run_node',
	{
		runId: text('run_id').notNull(),
		nodeId: text('node_id').notNull(),
		seq: integer('seq').notNull(),
		binding: text('binding').notNull(),
		state: text('state').notNull(),
		container: integer('container').notNull(),
		parent: text('parent'),
		origin: text('origin').notNull(),
		after: text('after').notNull(),
		jobId: text('job_id'),
		childRunId: text('child_run_id'),
		/** fan-outノードの集計値のみ, 通常ノードの戻り値はjob表へ投影済み(ADR-0035) */
		result: text('result'),
		error: text('error'),
		/** 画面の並び順 */
		position: integer('position').notNull(),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
	},
	(t) => [primaryKey({ columns: [t.runId, t.nodeId] }), index('run_node_run').on(t.runId, t.position)],
);
