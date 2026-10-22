import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * run 1件につき1インスタンス, `run`は常に1行(ADR-0029)
 * 進行中runの正のデータ, D1の読み取りモデルは投影先(ADR-0008)
 */
export const run = sqliteTable('run', {
	id: text('id').primaryKey(),
	flow: text('flow').notNull(),
	state: text('state').notNull(),
	input: text('input').notNull(),
	// 開始時固定, 定義変更の影響なし(ADR-0030)
	shape: text('shape').notNull(),
	cancelling: integer('cancelling').notNull().default(0),
	parentRunId: text('parent_run_id'),
	parentNodeId: text('parent_node_id'),
	depth: integer('depth').notNull().default(0),
	parentNotified: integer('parent_notified').notNull().default(0),
	// 再開時のdeadline_at再計算用(ADR-0039)
	deadlineMs: integer('deadline_ms'),
	deadlineAt: integer('deadline_at'),
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
		container: integer('container').notNull().default(0),
		parent: text('parent'),
		origin: text('origin').notNull(),
		after: text('after').notNull(),
		trigger: text('trigger').notNull().default('success'),
		payload: text('payload'),
		options: text('options'),
		subflow: text('subflow'),
		jobId: text('job_id'),
		childRunId: text('child_run_id'),
		result: text('result'),
		error: text('error'),
		seq: integer('seq').notNull(),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
	},
	(t) => [
		index('node_parent').on(t.parent),
		index('node_state').on(t.state),
		// 進行判断の毎tick全件順次読み取り用
		index('node_seq').on(t.seq, t.id),
	],
);

// run, node共用で分割時の冪等性追加を回避(ADR-0008)
export const runOutbox = sqliteTable('run_outbox', {
	seq: integer('seq').primaryKey({ autoIncrement: true }),
	kind: text('kind').notNull(),
	target: text('target').notNull(),
	snapshot: text('snapshot').notNull(),
});
