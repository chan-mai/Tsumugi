import { assertTransition } from '../core/transitions.js';
import type { Backoff, DeliveryGuarantee, JobState, JobView } from '../core/types.js';
import { applySchema, type JobRow } from './schema.js';

export type NewJob = {
	id: string;
	binding: string;
	priority: number;
	maxAttempts: number;
	concurrencyKey: string | null;
	uniqueKey: string | null;
	guarantee: DeliveryGuarantee;
	timeoutMs: number;
	backoff: Backoff;
	runAfter: number;
	createdAt: number;
	payload: unknown;
};

const toView = (row: JobRow): JobView => ({
	id: row.id,
	state: row.state as JobView['state'],
	priority: row.priority,
	attempts: row.attempts,
	maxAttempts: row.max_attempts,
	concurrencyKey: row.concurrency_key,
	runAfter: row.run_after,
	createdAt: row.created_at,
	dispatchedAt: row.dispatched_at,
	guarantee: row.guarantee as DeliveryGuarantee,
	timeoutMs: row.timeout_ms,
});

/**
 * SQLiteとJobViewの間の射影
 *
 * 状態遷移は必ず条件付きUPDATEで行い,読んでから書くことをしない
 * rowsWrittenで成否が分かるので競合に強く,書き込み回数も抑えられる(M2のclaimも同じ手法で実装する)
 */
export class JobRepo {
	readonly sql: SqlStorage;
	/** 書き込みを行うexecの回数, 1ジョブあたりの予算をテストで固定するために測る */
	writes = 0;
	/** 読み取りを行うexecの回数 */
	reads = 0;

	constructor(sql: SqlStorage) {
		this.sql = sql;
		applySchema(sql);
	}

	insert(job: NewJob): void {
		this.sql.exec(
			`INSERT INTO job (
				id, binding, state, priority, attempts, max_attempts, concurrency_key, unique_key,
				guarantee, timeout_ms, backoff, run_after, created_at, updated_at, dispatched_at, payload, run_id, node_id
			) VALUES (?, ?, 'SCHEDULED', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL)`,
			job.id,
			job.binding,
			job.priority,
			job.maxAttempts,
			job.concurrencyKey,
			job.uniqueKey,
			job.guarantee,
			job.timeoutMs,
			JSON.stringify(job.backoff),
			job.runAfter,
			job.createdAt,
			job.createdAt,
			JSON.stringify(job.payload),
		);
		this.writes++;
	}

	/** スケジューラに渡す稼働中ジョブ,有界にするためlimitを必須にする */
	activeJobs(limit: number): JobView[] {
		const rows = this.sql
			.exec<JobRow>(`SELECT * FROM job WHERE state IN ('SCHEDULED', 'QUEUED', 'RUNNING') ORDER BY created_at ASC, id ASC LIMIT ?`, limit)
			.toArray();
		this.reads++;
		return rows.map(toView);
	}

	countActive(): number {
		const row = this.sql.exec<{ c: number }>(`SELECT COUNT(*) AS c FROM job WHERE state IN ('SCHEDULED', 'QUEUED', 'RUNNING')`).one();
		this.reads++;
		return row.c;
	}

	find(id: string): JobRow | undefined {
		const rows = this.sql.exec<JobRow>(`SELECT * FROM job WHERE id = ?`, id).toArray();
		this.reads++;
		return rows[0];
	}

	/**
	 * 条件付きの状態遷移,現在の状態がfromのいずれかと一致する時だけ書き換える
	 * 一致しなければfalseを返す(重複配送や競合で既に進んでいた場合)
	 * 読んでから書かないので競合に強く,書き込みも1回で済む
	 */
	compareAndSet(
		id: string,
		from: readonly JobState[],
		to: JobState,
		patch: { now: number; dispatchedAt?: number | null; attempts?: number; runAfter?: number },
	): boolean {
		for (const state of from) assertTransition(state, to);
		const sets = ['state = ?', 'updated_at = ?'];
		const args: unknown[] = [to, patch.now];
		if (patch.dispatchedAt !== undefined) {
			sets.push('dispatched_at = ?');
			args.push(patch.dispatchedAt);
		}
		if (patch.attempts !== undefined) {
			sets.push('attempts = ?');
			args.push(patch.attempts);
		}
		if (patch.runAfter !== undefined) {
			sets.push('run_after = ?');
			args.push(patch.runAfter);
		}
		const placeholders = from.map(() => '?').join(', ');
		const cursor = this.sql.exec(`UPDATE job SET ${sets.join(', ')} WHERE id = ? AND state IN (${placeholders})`, ...args, id, ...from);
		this.writes++;
		return cursor.rowsWritten > 0;
	}

	payloadOf(row: JobRow): unknown {
		return JSON.parse(row.payload);
	}

	/**
	 * 重複排除の予約(ADR-0021 / ADR-0022)
	 * 取れたらnull,既に取られていれば先行するジョブIDを返す
	 * DOはシングルスレッドなので検査と挿入が何もせずとも不可分になる
	 */
	reserveUniqueKey(key: string, jobId: string, expiresAt: number, now: number): string | null {
		this.sql.exec(`DELETE FROM unique_key WHERE expires_at <= ?`, now);
		this.writes++;
		const cursor = this.sql.exec(
			`INSERT INTO unique_key (key, job_id, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING`,
			key,
			jobId,
			expiresAt,
		);
		this.writes++;
		if (cursor.rowsWritten > 0) return null;

		const rows = this.sql.exec<{ job_id: string }>(`SELECT job_id FROM unique_key WHERE key = ?`, key).toArray();
		this.reads++;
		return rows[0]?.job_id ?? null;
	}

	readSetting(key: string): string | undefined {
		const rows = this.sql.exec<{ value: string }>(`SELECT value FROM setting WHERE key = ?`, key).toArray();
		this.reads++;
		return rows[0]?.value;
	}

	writeSetting(key: string, value: string): void {
		this.sql.exec(`INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value);
		this.writes++;
	}
}
