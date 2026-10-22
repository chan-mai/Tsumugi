import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { JobLogEntry } from '../core/log.js';
import type { AttemptRow, JobRow } from '../do/schema.js';
import { job } from './tables.js';

export type OutboxRow = { seq: number; job_id: string; snapshot: string };

type JobSnapshot = Omit<JobRow, 'traceparent'> & { traceparent?: string | null; attempts_log?: AttemptRow[]; logs?: JobLogEntry[] };

// 衝突時の非更新列, `id`と`created_at`はジョブの同一性
// `binding`と`guarantee`は投入時確定で不変
const IMMUTABLE = ['id', 'createdAt', 'binding', 'guarantee'] as const;

function toValues(snapshot: JobSnapshot, seq: number): typeof job.$inferInsert {
	return {
		id: snapshot.id,
		seq,
		binding: snapshot.binding,
		state: snapshot.state,
		priority: snapshot.priority,
		attempts: snapshot.attempts,
		maxAttempts: snapshot.max_attempts,
		concurrencyKey: snapshot.concurrency_key,
		uniqueKey: snapshot.unique_key,
		guarantee: snapshot.guarantee,
		createdAt: snapshot.created_at,
		updatedAt: snapshot.updated_at,
		dispatchedAt: snapshot.dispatched_at,
		// 旧スナップショットの欠落列はnullへ統一
		runAfter: snapshot.run_after ?? null,
		expiresAt: snapshot.expires_at ?? null,
		cancelRequestedAt: snapshot.cancel_requested_at ?? null,
		progress: snapshot.progress ?? null,
		payload: snapshot.payload,
		// 旧スナップショットはresult無し, nullへ統一(#9)
		result: snapshot.result ?? null,
		traceparent: snapshot.traceparent ?? null,
		runId: snapshot.run_id,
		nodeId: snapshot.node_id,
		// 履歴無しはnull, 空配列は取得失敗と区別不能
		attemptsLog: snapshot.attempts_log && snapshot.attempts_log.length > 0 ? JSON.stringify(snapshot.attempts_log) : null,
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

// batch引数の型, drizzle内部型への依存回避で推論から取得
type Upsert = ReturnType<typeof toStatements>[number];

/** `excluded.seq > job.seq`で古い状態の上書き防止, 再送や順序入れ替わりでも結果不変(ADR-0008) */
export function toStatements(db: D1Database, rows: readonly OutboxRow[]) {
	const d = drizzle(db);
	return latestPerKey(rows, (row) => row.job_id).map((outbox) => {
		const values = toValues(JSON.parse(outbox.snapshot) as JobSnapshot, outbox.seq);
		const set = Object.fromEntries(
			Object.entries(values).filter(([column]) => !(IMMUTABLE as readonly string[]).includes(column)),
		) as Partial<typeof job.$inferInsert>;

		return d
			.insert(job)
			.values(values)
			.onConflictDoUpdate({
				target: job.id,
				set,
				setWhere: sql`excluded.seq > ${job.seq}`,
			});
	});
}

export async function project(db: D1Database, rows: readonly OutboxRow[]): Promise<void> {
	if (rows.length === 0) return;
	const statements = toStatements(db, rows);
	// batchは非空タプル必須, 長さは確認済み
	await drizzle(db).batch(statements as [Upsert, ...Upsert[]]);
}
