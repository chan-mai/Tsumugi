import { and, asc, desc, eq, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { assertTransition } from '../core/transitions.js';
import type { Backoff, DeliveryGuarantee, JobState, JobView, Retention } from '../core/types.js';
import { applySchema, type AttemptRow, type JobRow } from './schema.js';
import { attempt, job, outbox, setting, uniqueKey } from './tables.js';

/**
 * 1試行あたりのエラー本文の上限
 * performerの例外はHTMLページ丸ごとのこともあり,無制限だとDOとD1の両方を圧迫する
 */
export const ERROR_MAX_CHARS = 2_000;

/** 1ジョブあたりに残す試行の数, maxAttemptsを大きくしてもスナップショットが膨らまないようにする */
export const ATTEMPT_KEEP = 20;

const ACTIVE = ['SCHEDULED', 'QUEUED', 'RUNNING'] as const;

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
 * 掃除の対象条件
 * 削除と判定で同じ式を使う, 片方だけ直すと消える条件と起きる条件がずれる
 */
const sweepable = (now: number, retention: Retention) =>
	or(
		and(inArray(job.state, ['COMPLETED', 'CANCELLED']), lt(job.updatedAt, now - retention.doneMs)),
		and(inArray(job.state, ['FAILED', 'STALLED']), lt(job.updatedAt, now - retention.failedMs)),
	);

/**
 * SQLiteとJobViewの間の射影
 *
 * 状態遷移は必ず条件付きUPDATEで行い,読んでから書くことをしない
 * 更新できた行を`returning`で受けて成否を判定するので競合に強く,書き込み回数も抑えられる
 */
export class JobRepo {
	readonly db: DrizzleSqliteDODatabase<Record<string, never>>;
	/** 畳み込んだ読み取りなど, クエリビルダで表現できないものに使う */
	readonly sql: SqlStorage;
	/** 書き込みを行うクエリの回数, 1ジョブあたりの予算をテストで固定するために測る */
	writes = 0;
	/** 読み取りを行うクエリの回数 */
	reads = 0;

	constructor(storage: DurableObjectStorage) {
		this.sql = storage.sql;
		applySchema(storage.sql);
		this.db = drizzle(storage);
	}

	insert(newJob: NewJob): void {
		this.db
			.insert(job)
			.values({
				id: newJob.id,
				binding: newJob.binding,
				state: 'SCHEDULED',
				priority: newJob.priority,
				attempts: 0,
				maxAttempts: newJob.maxAttempts,
				concurrencyKey: newJob.concurrencyKey,
				uniqueKey: newJob.uniqueKey,
				guarantee: newJob.guarantee,
				timeoutMs: newJob.timeoutMs,
				backoff: JSON.stringify(newJob.backoff),
				runAfter: newJob.runAfter,
				createdAt: newJob.createdAt,
				updatedAt: newJob.createdAt,
				dispatchedAt: null,
				payload: JSON.stringify(newJob.payload),
				runId: null,
				nodeId: null,
			})
			.run();
		this.writes++;
		this.#appendOutbox(newJob.id);
	}

	/**
	 * D1への投影待ちに積む(ADR-0008)
	 * D1へUPSERTする内容そのものを持たせ,投影側が追加の読み取りをしなくて済むようにする
	 */
	#appendOutbox(id: string): void {
		const row = this.find(id);
		if (!row) return;
		// 試行履歴も同梱する, 別経路にすると冪等性の判定をもう1つ作ることになる(ADR-0028)
		this.db
			.insert(outbox)
			.values({ jobId: id, snapshot: JSON.stringify({ ...row, attempts_log: this.attemptsOf(id) }) })
			.run();
		this.writes++;
	}

	/** 新しい試行から順に返す, 打ち切りは古い方から */
	attemptsOf(jobId: string): AttemptRow[] {
		const rows = this.db.select().from(attempt).where(eq(attempt.jobId, jobId)).orderBy(desc(attempt.attempt)).limit(ATTEMPT_KEEP).all();
		this.reads++;
		return rows.map((r) => ({
			job_id: r.jobId,
			attempt: r.attempt,
			state: r.state,
			started_at: r.startedAt,
			finished_at: r.finishedAt,
			error: r.error,
		}));
	}

	/**
	 * 試行1回ぶんを記録する
	 * 同じ試行番号で二重に報告が来ても内容を置き換えるだけにする, 重複配送で行が増えない
	 */
	recordAttempt(record: AttemptRow): void {
		const values = {
			jobId: record.job_id,
			attempt: record.attempt,
			state: record.state,
			startedAt: record.started_at,
			finishedAt: record.finished_at,
			error: record.error === null ? null : record.error.slice(0, ERROR_MAX_CHARS),
		};
		this.db
			.insert(attempt)
			.values(values)
			.onConflictDoUpdate({
				target: [attempt.jobId, attempt.attempt],
				set: { state: values.state, startedAt: values.startedAt, finishedAt: values.finishedAt, error: values.error },
			})
			.run();
		this.writes++;
	}

	outboxBatch(limit: number): { seq: number; job_id: string; snapshot: string }[] {
		const rows = this.db.select().from(outbox).orderBy(asc(outbox.seq)).limit(limit).all();
		this.reads++;
		return rows.map((r) => ({ seq: r.seq, job_id: r.jobId, snapshot: r.snapshot }));
	}

	/** D1への書き込みが成功してから呼ぶ,失敗時はカーソルを進めない */
	deleteOutboxThrough(seq: number): void {
		this.db.delete(outbox).where(lte(outbox.seq, seq)).run();
		this.writes++;
	}

	countOutbox(): number {
		const row = this.db
			.select({ c: sql<number>`count(*)` })
			.from(outbox)
			.get();
		this.reads++;
		return row?.c ?? 0;
	}

	/** スケジューラに渡す稼働中ジョブ,有界にするためlimitを必須にする */
	activeJobs(limit: number): JobView[] {
		const rows = this.db
			.select()
			.from(job)
			.where(inArray(job.state, [...ACTIVE]))
			.orderBy(asc(job.createdAt), asc(job.id))
			.limit(limit)
			.all();
		this.reads++;
		return rows.map((r) => toView(this.#toJobRow(r)));
	}

	countActive(): number {
		const row = this.db
			.select({ c: sql<number>`count(*)` })
			.from(job)
			.where(inArray(job.state, [...ACTIVE]))
			.get();
		this.reads++;
		return row?.c ?? 0;
	}

	find(id: string): JobRow | undefined {
		const row = this.db.select().from(job).where(eq(job.id, id)).get();
		this.reads++;
		return row ? this.#toJobRow(row) : undefined;
	}

	/** drizzleのキャメルケースを, 投影とテストが読むスネークケースの行に戻す */
	#toJobRow(r: typeof job.$inferSelect): JobRow {
		return {
			id: r.id,
			binding: r.binding,
			state: r.state,
			priority: r.priority,
			attempts: r.attempts,
			max_attempts: r.maxAttempts,
			concurrency_key: r.concurrencyKey,
			unique_key: r.uniqueKey,
			guarantee: r.guarantee,
			timeout_ms: r.timeoutMs,
			backoff: r.backoff,
			run_after: r.runAfter,
			created_at: r.createdAt,
			updated_at: r.updatedAt,
			dispatched_at: r.dispatchedAt,
			payload: r.payload,
			run_id: r.runId,
			node_id: r.nodeId,
		};
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
		patch: { now: number; dispatchedAt?: number | null; attempts?: number; runAfter?: number; countAttempt?: boolean },
	): boolean {
		for (const state of from) assertTransition(state, to);

		const set: Record<string, unknown> = { state: to, updatedAt: patch.now };
		if (patch.dispatchedAt !== undefined) set.dispatchedAt = patch.dispatchedAt;
		if (patch.attempts !== undefined) set.attempts = patch.attempts;
		if (patch.runAfter !== undefined) set.runAfter = patch.runAfter;
		// 現在値を読まずに加算する,成功報告の経路で読み取りを増やさないため
		if (patch.countAttempt) set.attempts = sql`${job.attempts} + 1`;

		// 更新できた行を受け取って成否を判定する, drizzleのrunは影響行数を返さない
		const updated = this.db
			.update(job)
			.set(set)
			.where(and(eq(job.id, id), inArray(job.state, [...from])))
			.returning({ id: job.id })
			.all();
		this.writes++;
		if (updated.length === 0) return false;
		this.#appendOutbox(id);
		return true;
	}

	payloadOf(row: JobRow): unknown {
		return JSON.parse(row.payload);
	}

	/**
	 * 終端に達した古いジョブをDOから落とす
	 *
	 * DOのSQLiteは1インスタンス10GBが上限で,行数が増えるとtickのクエリも重くなる
	 * 明細はD1の読み取りモデルに投影済みなので, DO側に残し続ける理由がない
	 *
	 * 投影が滞っていても消して構わない
	 * アウトボックスはD1へUPSERTする内容そのものを持っており,ジョブ行を参照しないため
	 *
	 * 保持期間は役割の違う2つを別の数字で持つ(ADR-0027)
	 * doneMsは済んだジョブ, failedMsは人手で再開する余地のあるジョブ
	 */
	sweepTerminal(now: number, retention: Retention, limit: number): number {
		const targets = this.db.select({ id: job.id }).from(job).where(sweepable(now, retention)).limit(limit);

		// 先に履歴を落とす, ジョブ行を消してから引くと対象が引けなくなり孤児が残る
		this.db.delete(attempt).where(inArray(attempt.jobId, targets)).run();
		this.writes++;

		const deleted = this.db.delete(job).where(inArray(job.id, targets)).returning({ id: job.id }).all();
		this.writes++;
		return deleted.length;
	}

	/**
	 * 掃除する対象と次に対象が出る時刻を1回の読み取りで見る
	 * 対象が無くてもDELETEを撃つと書き込みが増える,読み取りは書き込みより桁で安価
	 *
	 * nextDueAtを返すのは無駄な起床を避けるため
	 * 失敗ジョブだけが残る状態で短い間隔のalarmを張り続けると,何もしない書き込みが延々と積まれる
	 *
	 * 3つの集計を1文に畳んでいるためクエリビルダでは表現できず, 生SQLのまま残す
	 */
	sweepState(now: number, retention: Retention): { jobs: boolean; uniqueKeys: boolean; nextDueAt: number | null } {
		const row = this.sql
			.exec<{ jobs: number; unique_keys: number; next_due: number | null }>(
				`SELECT
					EXISTS(SELECT 1 FROM job WHERE
						(state IN ('COMPLETED', 'CANCELLED') AND updated_at < ?1)
						OR (state IN ('FAILED', 'STALLED') AND updated_at < ?2)) AS jobs,
					EXISTS(SELECT 1 FROM unique_key WHERE expires_at <= ?3) AS unique_keys,
					(SELECT MIN(CASE WHEN state IN ('FAILED', 'STALLED') THEN updated_at + ?5 ELSE updated_at + ?4 END)
					 FROM job WHERE state IN ('COMPLETED', 'FAILED', 'CANCELLED', 'STALLED')) AS next_due`,
				now - retention.doneMs,
				now - retention.failedMs,
				now,
				retention.doneMs,
				retention.failedMs,
			)
			.one();
		this.reads++;
		return { jobs: row.jobs === 1, uniqueKeys: row.unique_keys === 1, nextDueAt: row.next_due };
	}

	/** 期限切れの重複排除キー, enqueueが途絶えても溜まらないようtickでも掃除する */
	sweepExpiredUniqueKeys(now: number): number {
		const deleted = this.db.delete(uniqueKey).where(lte(uniqueKey.expiresAt, now)).returning({ key: uniqueKey.key }).all();
		this.writes++;
		return deleted.length;
	}

	countJobs(): number {
		const row = this.db
			.select({ c: sql<number>`count(*)` })
			.from(job)
			.get();
		this.reads++;
		return row?.c ?? 0;
	}

	/**
	 * 重複排除の予約(ADR-0021 / ADR-0022)
	 * 取れたらnull,既に取られていれば先行するジョブIDを返す
	 * DOはシングルスレッドなので検査と挿入が何もせずとも不可分になる
	 */
	reserveUniqueKey(key: string, jobId: string, expiresAt: number, now: number): string | null {
		this.db.delete(uniqueKey).where(lte(uniqueKey.expiresAt, now)).run();
		this.writes++;

		const inserted = this.db
			.insert(uniqueKey)
			.values({ key, jobId, expiresAt })
			.onConflictDoNothing()
			.returning({ key: uniqueKey.key })
			.all();
		this.writes++;
		if (inserted.length > 0) return null;

		const row = this.db.select({ jobId: uniqueKey.jobId }).from(uniqueKey).where(eq(uniqueKey.key, key)).get();
		this.reads++;
		return row?.jobId ?? null;
	}

	readSetting(key: string): string | undefined {
		const row = this.db.select({ value: setting.value }).from(setting).where(eq(setting.key, key)).get();
		this.reads++;
		return row?.value;
	}

	writeSetting(key: string, value: string): void {
		this.db.insert(setting).values({ key, value }).onConflictDoUpdate({ target: setting.key, set: { value } }).run();
		this.writes++;
	}
}
