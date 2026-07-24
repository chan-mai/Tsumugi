import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { AttemptRow, JobRow } from '../do/schema.js';
import { job } from './tables.js';

export type OutboxRow = { seq: number; job_id: string; snapshot: string };

/** アウトボックスのスナップショット, ジョブ行に試行履歴を同梱した形(ADR-0028) */
export type JobSnapshot = JobRow & { attempts_log?: AttemptRow[] };

/**
 * 衝突時に更新しない列
 *
 * `id`と`created_at`はジョブの同一性そのもので書き換えてはならない
 * `binding`と`guarantee`は投入時に決まりその後変わらないので, 更新対象に入れる意味がない
 */
const IMMUTABLE = ['id', 'createdAt', 'binding', 'guarantee'] as const;

/** スナップショットを読み取りモデルの行に写す */
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
		payload: snapshot.payload,
		// 古いスナップショットにはresultが無いのでnullに寄せる(#9)
		result: snapshot.result ?? null,
		runId: snapshot.run_id,
		nodeId: snapshot.node_id,
		// 履歴が無いジョブでnullを入れる, 空配列にすると「取れなかった」と区別できない
		attemptsLog: snapshot.attempts_log && snapshot.attempts_log.length > 0 ? JSON.stringify(snapshot.attempts_log) : null,
	};
}

/** batchへ渡す文の型, 手で書くとdrizzleの内部型に依存するので推論から取る */
type Upsert = ReturnType<typeof toStatements>[number];

/**
 * D1への投影(ADR-0008)
 *
 * `setWhere`の`excluded.seq > job.seq`で古い状態の上書きを弾く,同じ範囲を何度流しても結果は不変
 * 再送や順序の入れ替わりでも古い状態が新しい状態を上書きしない
 */
export function toStatements(db: D1Database, rows: readonly OutboxRow[]) {
	const d = drizzle(db);
	return rows.map((outbox) => {
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
	// batchは空でないタプルを要求する, 呼び出し前に長さを確かめている
	await drizzle(db).batch(statements as [Upsert, ...Upsert[]]);
}
