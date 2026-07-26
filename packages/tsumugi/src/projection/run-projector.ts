import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { NodeSnapshot, RunSnapshot } from '../do/run-repo.js';
import { run, runNode } from './run-tables.js';

export type RunOutboxRow = { seq: number; kind: string; target: string; snapshot: string };

/**
 * runの読み取りモデルへの投影(ADR-0008)
 *
 * ジョブ側と同じく`excluded.seq > seq`で古い状態の上書きを弾く
 * 同じ範囲を何度流しても結果は不変なので, 送信の再試行が安全になる
 */
function toRunValues(snapshot: RunSnapshot, seq: number): typeof run.$inferInsert {
	return {
		id: snapshot.id,
		seq,
		flow: snapshot.flow,
		state: snapshot.state,
		input: snapshot.input,
		nodeTotal: snapshot.node_total,
		nodeDone: snapshot.node_done,
		nodeFailed: snapshot.node_failed,
		createdAt: snapshot.created_at,
		updatedAt: snapshot.updated_at,
		parentRunId: snapshot.parent_run_id,
		parentNodeId: snapshot.parent_node_id,
	};
}

function toNodeValues(snapshot: NodeSnapshot, seq: number): typeof runNode.$inferInsert {
	return {
		runId: snapshot.run_id,
		nodeId: snapshot.node_id,
		seq,
		binding: snapshot.binding,
		state: snapshot.state,
		container: snapshot.container,
		parent: snapshot.parent,
		origin: snapshot.origin,
		after: snapshot.after,
		jobId: snapshot.job_id,
		childRunId: snapshot.child_run_id,
		result: snapshot.result,
		error: snapshot.error,
		position: snapshot.position,
		createdAt: snapshot.created_at,
		updatedAt: snapshot.updated_at,
	};
}

type Upsert = ReturnType<typeof toStatements>[number];

export function toStatements(db: D1Database, rows: readonly RunOutboxRow[]) {
	const d = drizzle(db);
	return rows.map((row) => {
		if (row.kind === 'run') {
			const values = toRunValues(JSON.parse(row.snapshot) as RunSnapshot, row.seq);
			const { id: _id, createdAt: _createdAt, flow: _flow, ...mutable } = values;
			return d
				.insert(run)
				.values(values)
				.onConflictDoUpdate({
					target: run.id,
					set: mutable,
					setWhere: sql`excluded.seq > ${run.seq}`,
				});
		}

		const values = toNodeValues(JSON.parse(row.snapshot) as NodeSnapshot, row.seq);
		const { runId: _runId, nodeId: _nodeId, createdAt: _createdAt, binding: _binding, ...mutable } = values;
		return d
			.insert(runNode)
			.values(values)
			.onConflictDoUpdate({
				target: [runNode.runId, runNode.nodeId],
				set: mutable,
				setWhere: sql`excluded.seq > ${runNode.seq}`,
			});
	});
}

export async function projectRun(db: D1Database, rows: readonly RunOutboxRow[]): Promise<void> {
	if (rows.length === 0) return;
	const statements = toStatements(db, rows);
	await drizzle(db).batch(statements as [Upsert, ...Upsert[]]);
}

/** 画面の詳細で使う, 1つのrunのノードを並び順で引く */
export function nodesOf(db: D1Database, runId: string) {
	return drizzle(db).select().from(runNode).where(eq(runNode.runId, runId)).orderBy(runNode.position);
}

/** ジョブから辿る用, runIdとnodeIdの組で1件引く */
export function nodeOf(db: D1Database, runId: string, nodeId: string) {
	return drizzle(db)
		.select()
		.from(runNode)
		.where(and(eq(runNode.runId, runId), eq(runNode.nodeId, nodeId)))
		.limit(1);
}
