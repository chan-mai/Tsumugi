import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * runの読み取りモデル(ADR-0008 / ADR-0029)
 *
 * Run DOはrunごとに独立しているので, 横断的な一覧はここにしか作れない
 * DDLは`migrations/`のSQLが持ち, ここは型とクエリのための定義
 */
export const run = sqliteTable(
	'run',
	{
		id: text('id').primaryKey(),
		// 投影元のアウトボックス連番, 古い投影が新しい状態を上書きするのを弾く
		seq: integer('seq').notNull(),
		flow: text('flow').notNull(),
		state: text('state').notNull(),
		input: text('input').notNull(),
		nodeTotal: integer('node_total').notNull(),
		nodeDone: integer('node_done').notNull(),
		nodeFailed: integer('node_failed').notNull(),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		/** subflowとして起動された場合の親 */
		parentRunId: text('parent_run_id'),
		parentNodeId: text('parent_node_id'),
	},
	(t) => [
		index('run_state').on(t.state, t.updatedAt),
		index('run_flow').on(t.flow, t.updatedAt),
		index('run_created').on(t.createdAt),
		// 既定の一覧はフィルタ無しでupdated_atの降順, 先頭列がupdated_atの索引が要る
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
		/** subflowノードが起動した子のrunID */
		childRunId: text('child_run_id'),
		/** fan-outノードの集計値のみが入る,通常ノードの戻り値はjob表に投影済み(ADR-0035) */
		result: text('result'),
		error: text('error'),
		/** 画面の並び順 */
		position: integer('position').notNull(),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
	},
	(t) => [primaryKey({ columns: [t.runId, t.nodeId] }), index('run_node_run').on(t.runId, t.position)],
);

export type ReadModelRun = typeof run.$inferSelect;
export type ReadModelRunNode = typeof runNode.$inferSelect;
