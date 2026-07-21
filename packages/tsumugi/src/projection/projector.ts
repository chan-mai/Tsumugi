import type { AttemptRow, JobRow } from '../do/schema.js';

export type OutboxRow = { seq: number; job_id: string; snapshot: string };

/** アウトボックスのスナップショット, ジョブ行に試行履歴を同梱した形(ADR-0028) */
export type JobSnapshot = JobRow & { attempts_log?: AttemptRow[] };

/**
 * D1への投影(ADR-0008)
 *
 * `WHERE excluded.seq > job.seq`が番人,同じ範囲を何度流しても結果は不変
 * 再送や順序の入れ替わりでも古い状態が新しい状態を上書きしない
 */
const UPSERT = `
INSERT INTO job (
	id, seq, binding, state, priority, attempts, max_attempts, concurrency_key, unique_key,
	guarantee, created_at, updated_at, dispatched_at, payload, run_id, node_id, attempts_log
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
	seq = excluded.seq,
	state = excluded.state,
	priority = excluded.priority,
	attempts = excluded.attempts,
	max_attempts = excluded.max_attempts,
	concurrency_key = excluded.concurrency_key,
	unique_key = excluded.unique_key,
	updated_at = excluded.updated_at,
	dispatched_at = excluded.dispatched_at,
	payload = excluded.payload,
	run_id = excluded.run_id,
	node_id = excluded.node_id,
	attempts_log = excluded.attempts_log
WHERE excluded.seq > job.seq
`;

export function toStatements(db: D1Database, rows: readonly OutboxRow[]): D1PreparedStatement[] {
	return rows.map((outbox) => {
		const job = JSON.parse(outbox.snapshot) as JobSnapshot;
		return db.prepare(UPSERT).bind(
			job.id,
			outbox.seq,
			job.binding,
			job.state,
			job.priority,
			job.attempts,
			job.max_attempts,
			job.concurrency_key,
			job.unique_key,
			job.guarantee,
			job.created_at,
			job.updated_at,
			job.dispatched_at,
			job.payload,
			job.run_id,
			job.node_id,
			// 履歴が無いジョブでnullを入れる, 空配列にすると「取れなかった」と区別できない
			job.attempts_log && job.attempts_log.length > 0 ? JSON.stringify(job.attempts_log) : null,
		);
	});
}

export async function project(db: D1Database, rows: readonly OutboxRow[]): Promise<void> {
	if (rows.length === 0) return;
	await db.batch(toStatements(db, rows));
}
