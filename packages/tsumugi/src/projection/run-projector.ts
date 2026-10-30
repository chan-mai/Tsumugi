import type { NodeSnapshot, RunSnapshot } from '../do/run-repo.js';
import { upsertOf, type ReadModelRow, type Upsert } from './columns.js';
import { latestPerKey } from './projector.js';

export type RunOutboxRow = { seq: number; kind: string; target: string; snapshot: string };

// ジョブ側と同じく`excluded.seq > seq`で古い状態の上書き防止, 送信再試行も安全
function toRunValues(snapshot: RunSnapshot, seq: number): ReadModelRow<'run'> {
	return { ...snapshot, seq };
}

function toNodeValues(snapshot: NodeSnapshot, seq: number): ReadModelRow<'run_node'> {
	return { ...snapshot, seq };
}

export function toUpserts(rows: readonly RunOutboxRow[]): Upsert[] {
	return latestPerKey(rows, (row) => `${row.kind}:${row.target}`).map((row) =>
		row.kind === 'run'
			? upsertOf('run', toRunValues(JSON.parse(row.snapshot) as RunSnapshot, row.seq), ['id'], ['created_at', 'flow'])
			: upsertOf(
					'run_node',
					toNodeValues(JSON.parse(row.snapshot) as NodeSnapshot, row.seq),
					['run_id', 'node_id'],
					['created_at', 'binding'],
				),
	);
}

export async function projectRun(db: D1Database, rows: readonly RunOutboxRow[]): Promise<void> {
	if (rows.length === 0) return;
	await db.batch(toUpserts(rows).map((upsert) => db.prepare(upsert.sql).bind(...upsert.params)));
}
