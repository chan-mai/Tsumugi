import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { ACTIVE_STATES, assertTransition, FAILURE_STATES, TERMINAL_STATES } from '../core/transitions.js';
import { LOG_KEEP, LOG_MAX_CHARS, LOG_MIN_INTERVAL_MS, type JobLogEntry } from '../core/log.js';
import type { NodeEvent, SpawnRequest } from '../core/run.js';
import type {
	Backoff,
	DeliveryGuarantee,
	FailureNotice,
	JobState,
	JobView,
	KeyBuckets,
	Retention,
	SettledNotice,
	SettledState,
	SettledTarget,
} from '../core/types.js';
import { chunk } from './bind.js';
import { applySchema, type AttemptRow, type JobRow } from './schema.js';
import { attempt, failureNotify, job, jobLog, keyBucket, outbox, runNotify, setting, settledNotify, uniqueKey } from './tables.js';

/** HTMLページ全体等によるDOとD1の圧迫防止 */
export const ERROR_MAX_CHARS = 2_000;

/**
 * スナップショットに含まれ毎回の投影で転送(#9)
 * 超過時はnull保存, 大きい結果はperformerがR2/KV/D1へ保存する運用
 */
export const RESULT_MAX_CHARS = 8_192;

/** スナップショット肥大防止 */
const ATTEMPT_KEEP = 20;

type NewJob = {
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
	expiresAt: number | null;
	createdAt: number;
	payload: unknown;
	traceparent?: string | null;
	runId?: string | null;
	nodeId?: string | null;
};

const SETTLED_TARGET_KEY = 'settled_target';

const toView = (row: JobRow): JobView => ({
	id: row.id,
	state: row.state as JobView['state'],
	priority: row.priority,
	attempts: row.attempts,
	maxAttempts: row.max_attempts,
	concurrencyKey: row.concurrency_key,
	runAfter: row.run_after,
	expiresAt: row.expires_at,
	createdAt: row.created_at,
	dispatchedAt: row.dispatched_at,
	heartbeatAt: row.heartbeat_at,
	guarantee: row.guarantee as DeliveryGuarantee,
	timeoutMs: row.timeout_ms,
	cancelRequestedAt: row.cancel_requested_at,
});

// sweepStateのSQLと同条件を維持
const sweepable = (now: number, retention: Retention) =>
	or(
		and(inArray(job.state, ['COMPLETED', 'CANCELLED']), lt(job.updatedAt, now - retention.sweepAfterMs)),
		and(inArray(job.state, ['FAILED', 'STALLED']), lt(job.updatedAt, now - retention.failedRetentionMs)),
	);

/** 状態遷移は条件付きUPDATEの`returning`で成否判定, 読んでから書く方式は不使用 */
export class JobRepo {
	readonly db: DrizzleSqliteDODatabase<Record<string, never>>;
	/** クエリビルダで表現不能な集計等用 */
	readonly sql: SqlStorage;
	/** 1ジョブあたり書き込み予算のテスト用 */
	writes = 0;
	// undefinedは未読込
	#settledTarget: SettledTarget | null | undefined;

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
				expiresAt: newJob.expiresAt,
				createdAt: newJob.createdAt,
				updatedAt: newJob.createdAt,
				dispatchedAt: null,
				heartbeatAt: null,
				progress: null,
				payload: JSON.stringify(newJob.payload),
				result: null,
				traceparent: newJob.traceparent ?? null,
				runId: newJob.runId ?? null,
				nodeId: newJob.nodeId ?? null,
			})
			.run();
		this.writes++;
		this.#appendOutbox(newJob.id);
	}

	// UPSERT内容そのもので投影側の追加読み取り不要(ADR-0008)
	#appendOutbox(id: string): { row: JobRow; attempts: AttemptRow[] } | null {
		const row = this.find(id);
		if (!row) return null;
		const attempts = this.attemptsOf(id);
		// 試行履歴も同梱, 別経路は冪等性判定が別途必要(ADR-0028)
		this.db
			.insert(outbox)
			.values({ jobId: id, snapshot: JSON.stringify({ ...row, attempts_log: attempts, logs: this.logsOf(id) }) })
			.run();
		this.writes++;
		return { row, attempts };
	}

	attemptsOf(jobId: string): AttemptRow[] {
		const rows = this.db.select().from(attempt).where(eq(attempt.jobId, jobId)).orderBy(desc(attempt.attempt)).limit(ATTEMPT_KEEP).all();
		return rows.map((r) => ({
			job_id: r.jobId,
			attempt: r.attempt,
			state: r.state,
			started_at: r.startedAt,
			finished_at: r.finishedAt,
			error: r.error,
		}));
	}

	logsOf(jobId: string): JobLogEntry[] {
		const rows = this.db
			.select({ attempt: jobLog.attempt, timestamp: jobLog.timestamp, message: jobLog.message })
			.from(jobLog)
			.where(eq(jobLog.jobId, jobId))
			.orderBy(asc(jobLog.seq))
			.limit(LOG_KEEP)
			.all();
		return rows;
	}

	log(id: string, attemptNumber: number, message: string, now: number): 'stored' | 'throttled' | 'rejected' {
		const row = this.find(id);
		if (!row || (row.state !== 'QUEUED' && row.state !== 'RUNNING') || row.attempts + 1 !== attemptNumber) return 'rejected';
		const history = this.db
			.select({ count: sql<number>`count(*)`, lastAt: sql<number | null>`max(${jobLog.timestamp})` })
			.from(jobLog)
			.where(eq(jobLog.jobId, id))
			.get();
		if (history?.lastAt !== null && history?.lastAt !== undefined && now - history.lastAt < LOG_MIN_INTERVAL_MS) return 'throttled';
		this.db
			.insert(jobLog)
			.values({ jobId: id, attempt: attemptNumber, timestamp: now, message: message.slice(0, LOG_MAX_CHARS) })
			.run();
		this.writes++;
		const excess = (history?.count ?? 0) + 1 - LOG_KEEP;
		if (excess > 0) {
			const oldest = this.db.select({ seq: jobLog.seq }).from(jobLog).where(eq(jobLog.jobId, id)).orderBy(asc(jobLog.seq)).limit(excess);
			this.db.delete(jobLog).where(inArray(jobLog.seq, oldest)).run();
			this.writes++;
		}
		this.#appendOutbox(id);
		return 'stored';
	}

	/** 同試行番号は置換, 重複配送でも1行 */
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
		return rows.map((r) => ({ seq: r.seq, job_id: r.jobId, snapshot: r.snapshot }));
	}

	/** D1書き込み成功後専用 */
	deleteOutboxThrough(seq: number): void {
		this.db.delete(outbox).where(lte(outbox.seq, seq)).run();
		this.writes++;
	}

	countOutbox(): number {
		const row = this.db
			.select({ c: sql<number>`count(*)` })
			.from(outbox)
			.get();
		return row?.c ?? 0;
	}

	hasOutbox(): boolean {
		const row = this.db.select({ seq: outbox.seq }).from(outbox).limit(1).get();
		return row !== undefined;
	}

	/**
	 * 役割ごとに別クエリ(ADR-0019 / ADR-0020, #4)
	 * 単一範囲では実行中と未到来が占有し実行可能ジョブが選考外
	 * limit超過の実行可能ジョブは次tick以降で処理
	 * readyCountはlimit到達時の即時再実行判定用
	 * inFlightLimitはconcurrency以上必須, 未満では実行中の過少計上で上限超過
	 */
	scheduleWindow(now: number, limit: number, inFlightLimit = limit): { jobs: JobView[]; readyCount: number } {
		// 実行中: reaper無応答判定と実行中件数集計用
		const inFlight = this.db
			.select()
			.from(job)
			.where(inArray(job.state, ['QUEUED', 'RUNNING']))
			.orderBy(asc(job.createdAt), asc(job.id))
			.limit(inFlightLimit)
			.all();
		// 実行可能: 投入候補, job_dueで到来順に取得し滞留時もlimit件まで(#104)
		const ready = this.db
			.select()
			.from(job)
			.where(and(eq(job.state, 'SCHEDULED'), lte(job.runAfter, now)))
			.orderBy(asc(job.runAfter), asc(job.id))
			.limit(limit)
			.all();
		// 未到来の最早1件: alarm設定用
		const future = this.db
			.select()
			.from(job)
			.where(and(eq(job.state, 'SCHEDULED'), gt(job.runAfter, now)))
			.orderBy(asc(job.runAfter))
			.limit(1)
			.all();
		// 3つは状態/run_afterで互いに素
		const jobs = [...inFlight, ...ready, ...future].map((r) => toView(this.#toJobRow(r)));
		return { jobs, readyCount: ready.length };
	}

	countActive(): number {
		const row = this.db
			.select({ c: sql<number>`count(*)` })
			.from(job)
			.where(inArray(job.state, [...ACTIVE_STATES]))
			.get();
		return row?.c ?? 0;
	}

	find(id: string): JobRow | undefined {
		const row = this.db.select().from(job).where(eq(job.id, id)).get();
		return row ? this.#toJobRow(row) : undefined;
	}

	// 投影とテスト用にスネークケースへ変換
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
			expires_at: r.expiresAt,
			created_at: r.createdAt,
			updated_at: r.updatedAt,
			dispatched_at: r.dispatchedAt,
			heartbeat_at: r.heartbeatAt,
			progress: r.progress,
			payload: r.payload,
			result: r.result,
			traceparent: r.traceparent,
			cancel_requested_at: r.cancelRequestedAt,
			run_id: r.runId,
			node_id: r.nodeId,
		};
	}

	compareAndSet(
		id: string,
		from: readonly JobState[],
		to: JobState,
		patch: {
			now: number;
			dispatchedAt?: number | null;
			attempts?: number;
			runAfter?: number;
			countAttempt?: boolean;
			result?: string | null;
			/** ジョブ行に保存しない失敗理由(ADR-0031) */
			error?: string | null;
			spawns?: readonly SpawnRequest[];
			/** 手動リトライ専用, 既定は維持(#95) */
			cancelRequestedAt?: null;
		},
	): boolean {
		for (const state of from) assertTransition(state, to);

		// 生存報告消去, 前試行の報告でのreaper期限延長防止
		const set: Record<string, unknown> = { state: to, updatedAt: patch.now, heartbeatAt: null, progress: null };
		if (patch.dispatchedAt !== undefined) set.dispatchedAt = patch.dispatchedAt;
		if (patch.attempts !== undefined) set.attempts = patch.attempts;
		if (patch.runAfter !== undefined) set.runAfter = patch.runAfter;
		if (patch.result !== undefined) set.result = patch.result;
		if (patch.countAttempt) set.attempts = sql`${job.attempts} + 1`;
		// 要求は既定で維持, reap後の再投入防止(#95)
		if (patch.cancelRequestedAt !== undefined) set.cancelRequestedAt = patch.cancelRequestedAt;

		// drizzleのrunは影響行数非返却でreturning使用, 宛先も同時取得(ADR-0031)
		const updated = this.db
			.update(job)
			.set(set)
			.where(and(eq(job.id, id), inArray(job.state, [...from])))
			.returning({ id: job.id, runId: job.runId, nodeId: job.nodeId })
			.all();
		this.writes++;
		const row = updated[0];
		if (!row) return false;
		const current = this.#appendOutbox(id);
		if (current && FAILURE_STATES.includes(to)) {
			this.#appendFailure(current.row, current.attempts, to as FailureNotice['state'], patch.error ?? null, patch.now);
		}
		if (current && TERMINAL_STATES.includes(to)) {
			this.#appendSettled(current.row, current.attempts, to as SettledState, patch.error ?? null, patch.now);
		}
		// 終端検出を1箇所に集約, 呼び出し側ごとの実装は漏れの原因
		if (row.runId !== null && row.nodeId !== null && TERMINAL_STATES.includes(to)) {
			this.appendRunNotify(row.runId, {
				nodeId: row.nodeId,
				jobId: id,
				state: to as NodeEvent['state'],
				result: patch.result ?? null,
				error: patch.error ?? null,
				...(patch.spawns && patch.spawns.length > 0 ? { spawns: patch.spawns } : {}),
			});
		}
		return true;
	}

	heartbeat(id: string, now: number, progress: number | null): { accepted: boolean; cancelRequested: boolean } {
		const set: Record<string, unknown> = { heartbeatAt: now };
		if (progress !== null) set.progress = progress;

		const updated = this.db
			.update(job)
			.set(set)
			.where(and(eq(job.id, id), inArray(job.state, ['QUEUED', 'RUNNING'])))
			.returning({ id: job.id, cancelRequestedAt: job.cancelRequestedAt })
			.all();
		this.writes++;
		const row = updated[0];
		if (!row) return { accepted: false, cancelRequested: false };
		// 進捗表示用の投影, 書き込み数は報告側の間隔制限で削減
		this.#appendOutbox(id);
		return { accepted: true, cancelRequested: row.cancelRequestedAt !== null };
	}

	requestCancel(id: string, now: number): boolean {
		const updated = this.db
			.update(job)
			.set({ cancelRequestedAt: now, updatedAt: now })
			.where(and(eq(job.id, id), inArray(job.state, ['QUEUED', 'RUNNING']), isNull(job.cancelRequestedAt)))
			.returning({ id: job.id })
			.all();
		this.writes++;
		if (updated.length === 0) return false;
		// 要求中表示用の投影
		this.#appendOutbox(id);
		return true;
	}

	/**
	 * 遷移表にSCHEDULED->SCHEDULEDが無く`compareAndSet`不使用(ADR-0012)
	 * 取り消し要求済みは対象外, runAfter後ろ倒しでの確定遅延防止(#95)
	 */
	reschedule(id: string, runAfter: number, priority: number | undefined, now: number): boolean {
		const set: Record<string, unknown> = { runAfter, updatedAt: now };
		if (priority !== undefined) set.priority = priority;

		const updated = this.db
			.update(job)
			.set(set)
			.where(and(eq(job.id, id), eq(job.state, 'SCHEDULED'), isNull(job.cancelRequestedAt)))
			.returning({ id: job.id })
			.all();
		this.writes++;
		if (updated.length === 0) return false;
		this.#appendOutbox(id);
		return true;
	}

	// 送信時はジョブ削除済みの可能性で内容をここで確定(#30)
	#appendFailure(row: JobRow, attempts: AttemptRow[], state: FailureNotice['state'], error: string | null, now: number): void {
		const notice: FailureNotice = {
			jobId: row.id,
			binding: row.binding,
			state,
			attempts: row.attempts,
			maxAttempts: row.max_attempts,
			// 理由無しは直近の試行から補完, reaper起因は理由無し
			error: error ?? attempts[0]?.error ?? null,
			runId: row.run_id,
			nodeId: row.node_id,
			failedAt: now,
		};
		this.db
			.insert(failureNotify)
			.values({ jobId: row.id, payload: JSON.stringify(notice) })
			.run();
		this.writes++;
	}

	failureBatch(limit: number): { seq: number; payload: string }[] {
		const rows = this.db.select().from(failureNotify).orderBy(asc(failureNotify.seq)).limit(limit).all();
		return rows.map((row) => ({ seq: row.seq, payload: row.payload }));
	}

	/** 投入成功後専用 */
	deleteFailureThrough(seq: number): void {
		this.db.delete(failureNotify).where(lte(failureNotify.seq, seq)).run();
		this.writes++;
	}

	/** `#loadPolicy`を経ない`compareAndSet`経路用にここで読込(#96) */
	settledTarget(): SettledTarget | null {
		if (this.#settledTarget === undefined) {
			const raw = this.readSetting(SETTLED_TARGET_KEY);
			this.#settledTarget = raw !== undefined ? (JSON.parse(raw) as SettledTarget) : null;
		}
		return this.#settledTarget;
	}

	writeSettledTarget(value: SettledTarget | null): void {
		this.#settledTarget = value;
		const stored = this.readSetting(SETTLED_TARGET_KEY);
		if (value === null) {
			if (stored !== undefined) this.deleteSetting(SETTLED_TARGET_KEY);
			return;
		}
		const encoded = JSON.stringify(value);
		if (stored !== encoded) this.writeSetting(SETTLED_TARGET_KEY, encoded);
	}

	// 送信時はジョブ削除済みの可能性で内容をここで確定(#96)
	#appendSettled(row: JobRow, attempts: AttemptRow[], state: SettledState, error: string | null, now: number): void {
		const target = this.settledTarget();
		if (target === null || !target.states.includes(state)) return;
		if (row.binding === target.binding) return;
		const notice: SettledNotice = {
			jobId: row.id,
			binding: row.binding,
			state,
			attempts: row.attempts,
			maxAttempts: row.max_attempts,
			error: error ?? (FAILURE_STATES.includes(state) ? (attempts[0]?.error ?? null) : null),
			result: row.result !== null ? JSON.parse(row.result) : null,
			runId: row.run_id,
			nodeId: row.node_id,
			settledAt: now,
		};
		this.db
			.insert(settledNotify)
			.values({ jobId: row.id, payload: JSON.stringify(notice) })
			.run();
		this.writes++;
	}

	settledBatch(limit: number): { seq: number; payload: string }[] {
		const rows = this.db.select().from(settledNotify).orderBy(asc(settledNotify.seq)).limit(limit).all();
		return rows.map((row) => ({ seq: row.seq, payload: row.payload }));
	}

	/** 投入成功後専用 */
	deleteSettledThrough(seq: number): void {
		this.db.delete(settledNotify).where(lte(settledNotify.seq, seq)).run();
		this.writes++;
	}

	countSettledNotify(): number {
		const row = this.db
			.select({ c: sql<number>`count(*)` })
			.from(settledNotify)
			.get();
		return row?.c ?? 0;
	}

	appendRunNotify(runId: string, event: NodeEvent): void {
		this.db
			.insert(runNotify)
			.values({ runId, event: JSON.stringify(event) })
			.run();
		this.writes++;
	}

	runNotifyBatch(limit: number): { seq: number; run_id: string; event: string }[] {
		const rows = this.db.select().from(runNotify).orderBy(asc(runNotify.seq)).limit(limit).all();
		return rows.map((row) => ({ seq: row.seq, run_id: row.runId, event: row.event }));
	}

	/** 送信成功後専用 */
	deleteRunNotifyThrough(seq: number): void {
		this.db.delete(runNotify).where(lte(runNotify.seq, seq)).run();
		this.writes++;
	}

	payloadOf(row: JobRow): unknown {
		return JSON.parse(row.payload);
	}

	/**
	 * DOのSQLite上限10GBとtickクエリ負荷対策
	 * outboxはジョブ行非参照で投影滞留中も削除可能
	 */
	sweepTerminal(now: number, retention: Retention, limit: number): number {
		const targets = this.db.select({ id: job.id }).from(job).where(sweepable(now, retention)).limit(limit);

		// ジョブ行より先に履歴削除, 後では対象特定不能
		this.db.delete(attempt).where(inArray(attempt.jobId, targets)).run();
		this.writes++;
		this.db.delete(jobLog).where(inArray(jobLog.jobId, targets)).run();
		this.writes++;

		// 件数はカーソルから取得, returningは全行転送
		const { sql: text, params } = this.db.delete(job).where(inArray(job.id, targets)).toSQL();
		const cursor = this.sql.exec(text, ...(params as SqlStorageValue[]));
		this.writes++;
		return cursor.rowsWritten;
	}

	/**
	 * 削除対象の有無と次回時刻を1回の読み取りで取得, 対象無しDELETEも書き込みに計上
	 * nextDueAtは失敗ジョブのみ残存時の短間隔alarm回避用
	 * 3集計の1文はクエリビルダで表現不能で生SQL
	 * next_dueは状態別MINでjob_terminalの先頭1件から取得(#104), 多引数min()はNULL含有でNULL
	 */
	sweepState(now: number, retention: Retention): { jobs: boolean; uniqueKeys: boolean; nextDueAt: number | null } {
		const row = this.sql
			.exec<{ jobs: number; unique_keys: number; next_due: number | null }>(
				`SELECT
					EXISTS(SELECT 1 FROM job WHERE
						(state IN ('COMPLETED', 'CANCELLED') AND updated_at < ?1)
						OR (state IN ('FAILED', 'STALLED') AND updated_at < ?2)) AS jobs,
					EXISTS(SELECT 1 FROM unique_key WHERE expires_at <= ?3) AS unique_keys,
					(SELECT MIN(due) FROM (
						SELECT MIN(updated_at) + ?4 AS due FROM job WHERE state = 'COMPLETED'
						UNION ALL SELECT MIN(updated_at) + ?4 FROM job WHERE state = 'CANCELLED'
						UNION ALL SELECT MIN(updated_at) + ?5 FROM job WHERE state = 'FAILED'
						UNION ALL SELECT MIN(updated_at) + ?5 FROM job WHERE state = 'STALLED')) AS next_due`,
				now - retention.sweepAfterMs,
				now - retention.failedRetentionMs,
				now,
				retention.sweepAfterMs,
				retention.failedRetentionMs,
			)
			.one();
		return { jobs: row.jobs === 1, uniqueKeys: row.unique_keys === 1, nextDueAt: row.next_due };
	}

	/**
	 * enqueue途絶時用にtickでも実行
	 * 件数非返却, 上限無しで集計は全件転送
	 */
	sweepExpiredUniqueKeys(now: number): void {
		this.db.delete(uniqueKey).where(lte(uniqueKey.expiresAt, now)).run();
		this.writes++;
	}

	countJobs(): number {
		const row = this.db
			.select({ c: sql<number>`count(*)` })
			.from(job)
			.get();
		return row?.c ?? 0;
	}

	/**
	 * 重複排除キー予約(ADR-0021 / ADR-0022), 成功時null, 予約済みなら先行ジョブID
	 * DOはシングルスレッドで検査と挿入が不可分
	 */
	reserveUniqueKey(key: string, jobId: string, expiresAt: number, now: number): string | null {
		// 他キーの期限切れはtickで削除
		this.db
			.delete(uniqueKey)
			.where(and(eq(uniqueKey.key, key), lte(uniqueKey.expiresAt, now)))
			.run();
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
		return row?.jobId ?? null;
	}

	readSetting(key: string): string | undefined {
		const row = this.db.select({ value: setting.value }).from(setting).where(eq(setting.key, key)).get();
		return row?.value;
	}

	writeSetting(key: string, value: string): void {
		this.db.insert(setting).values({ key, value }).onConflictDoUpdate({ target: setting.key, set: { value } }).run();
		this.writes++;
	}

	deleteSetting(key: string): void {
		this.db.delete(setting).where(eq(setting.key, key)).run();
		this.writes++;
	}

	/** 投入候補キーのみで有界(ADR-0045) */
	readKeyBuckets(keys: readonly string[]): KeyBuckets {
		const buckets: KeyBuckets = Object.create(null);
		for (const part of chunk(keys, 1)) {
			const rows = this.db.select().from(keyBucket).where(inArray(keyBucket.key, part)).all();
			for (const r of rows) buckets[r.key] = { tokens: r.tokens, refilledAt: r.refilledAt };
		}
		return buckets;
	}

	writeKeyBuckets(buckets: KeyBuckets): void {
		for (const [key, b] of Object.entries(buckets)) {
			this.db
				.insert(keyBucket)
				.values({ key, tokens: b.tokens, refilledAt: b.refilledAt })
				.onConflictDoUpdate({ target: keyBucket.key, set: { tokens: b.tokens, refilledAt: b.refilledAt } })
				.run();
			this.writes++;
		}
	}

	deleteKeyBuckets(keys: readonly string[]): void {
		for (const part of chunk(keys, 1)) {
			this.db.delete(keyBucket).where(inArray(keyBucket.key, part)).run();
			this.writes++;
		}
	}

	/** tokens0以上はintervalMs以内に上限到達 */
	sweepKeyBuckets(before: number): void {
		this.db.delete(keyBucket).where(lte(keyBucket.refilledAt, before)).run();
		this.writes++;
	}

	/** perKeyRate無効化後の残存行削除用 */
	clearKeyBuckets(): void {
		this.db.delete(keyBucket).run();
		this.writes++;
	}

	countKeyBuckets(): number {
		const row = this.db
			.select({ c: sql<number>`count(*)` })
			.from(keyBucket)
			.get();
		return row?.c ?? 0;
	}
}
