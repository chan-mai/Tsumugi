import type { JobLogEntry } from '../core/log.js';
import type { AttemptRow, JobRow } from '../do/schema.js';
import { upsertOf, type ReadModelRow, type Upsert } from './columns.js';

export type OutboxRow = { seq: number; job_id: string; snapshot: string };

type JobSnapshot = Omit<JobRow, 'traceparent'> & { traceparent?: string | null; attempts_log?: AttemptRow[]; logs?: JobLogEntry[] };

// 衝突時の非更新列, キーの`id`と`created_at`はジョブの同一性
// `binding`と`guarantee`は投入時確定で不変
const IMMUTABLE = ['created_at', 'binding', 'guarantee'] as const;

function toValues(snapshot: JobSnapshot, seq: number): ReadModelRow<'job'> {
	return {
		id: snapshot.id,
		seq,
		binding: snapshot.binding,
		state: snapshot.state,
		priority: snapshot.priority,
		attempts: snapshot.attempts,
		max_attempts: snapshot.max_attempts,
		concurrency_key: snapshot.concurrency_key,
		unique_key: snapshot.unique_key,
		guarantee: snapshot.guarantee,
		created_at: snapshot.created_at,
		updated_at: snapshot.updated_at,
		dispatched_at: snapshot.dispatched_at,
		// 旧スナップショットの欠落列はnullへ統一
		run_after: snapshot.run_after ?? null,
		expires_at: snapshot.expires_at ?? null,
		cancel_requested_at: snapshot.cancel_requested_at ?? null,
		progress: snapshot.progress ?? null,
		payload: snapshot.payload,
		// 旧スナップショットはresult無し, nullへ統一(#9)
		result: snapshot.result ?? null,
		traceparent: snapshot.traceparent ?? null,
		run_id: snapshot.run_id,
		node_id: snapshot.node_id,
		// 履歴無しはnull, 空配列は取得失敗と区別不能
		attempts_log: snapshot.attempts_log && snapshot.attempts_log.length > 0 ? JSON.stringify(snapshot.attempts_log) : null,
		logs: snapshot.logs && snapshot.logs.length > 0 ? JSON.stringify(snapshot.logs) : null,
	};
}

// 最大seqの1件で結果同一
export function latestPerKey<T extends { seq: number }>(rows: readonly T[], keyOf: (row: T) => string): T[] {
	const latest = new Map<string, T>();
	for (const row of rows) {
		const current = latest.get(keyOf(row));
		if (!current || row.seq > current.seq) latest.set(keyOf(row), row);
	}
	return [...latest.values()];
}

export function toUpserts(rows: readonly OutboxRow[]): Upsert[] {
	return latestPerKey(rows, (row) => row.job_id).map((outbox) =>
		upsertOf('job', toValues(JSON.parse(outbox.snapshot) as JobSnapshot, outbox.seq), ['id'], IMMUTABLE),
	);
}

export async function project(db: D1Database, rows: readonly OutboxRow[]): Promise<void> {
	if (rows.length === 0) return;
	await db.batch(toUpserts(rows).map((upsert) => db.prepare(upsert.sql).bind(...upsert.params)));
}
