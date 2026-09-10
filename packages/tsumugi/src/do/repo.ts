import { and, asc, desc, eq, gt, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { assertTransition } from '../core/transitions.js';
import type { NodeEvent, SpawnRequest } from '../core/run.js';
import type { Backoff, DeliveryGuarantee, FailureNotice, JobState, JobView, KeyBuckets, Retention } from '../core/types.js';
import { applySchema, type AttemptRow, type JobRow } from './schema.js';
import { attempt, failureNotify, job, keyBucket, outbox, runNotify, setting, uniqueKey } from './tables.js';

/**
 * 1試行あたりのエラー本文の上限
 * performerの例外はHTMLページ丸ごとのこともあり、無制限だとDOとD1の両方を圧迫
 */
export const ERROR_MAX_CHARS = 2_000;

/**
 * performの戻り値の保存上限(#9)
 * 戻り値はアウトボックスのスナップショットに含まれ毎回の投影で転送され、無制限だとDOとD1を圧迫
 * 超える結果はR2/KV/D1へ自分で書く運用とし、ここではnullを保存
 */
export const RESULT_MAX_CHARS = 8_192;

/** 1ジョブあたりに残す試行の数, maxAttemptsを大きくした場合のスナップショットの肥大を防止 */
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
	/** 実行開始の期限, 無期限はnull */
	expiresAt: number | null;
	createdAt: number;
	payload: unknown;
	/** DAGのノードとして投入された場合の宛先(ADR-0015) */
	runId?: string | null;
	nodeId?: string | null;
};

/** 終端に達した時にRun DOへ知らせる状態(ADR-0031) */
const NOTIFIABLE: readonly JobState[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'STALLED'];

/** 外部へ知らせる状態(#30), 再試行で回復する途中の失敗は対象外 */
const FAILURES: readonly JobState[] = ['FAILED', 'STALLED'];

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
});

/**
 * 削除の対象条件
 * 削除と判定で同じ式を使用, 片方だけの修正は削除の条件とalarm設定の条件がずれる
 */
const sweepable = (now: number, retention: Retention) =>
	or(
		and(inArray(job.state, ['COMPLETED', 'CANCELLED']), lt(job.updatedAt, now - retention.doneMs)),
		and(inArray(job.state, ['FAILED', 'STALLED']), lt(job.updatedAt, now - retention.failedMs)),
	);

/**
 * SQLiteとJobViewの間の射影
 *
 * 状態遷移は必ず条件付きUPDATEで行い、読んでから書く方式は不使用
 * 更新できた行を`returning`で受けて成否を判定, 競合に強く書き込み回数も削減
 */
export class JobRepo {
	readonly db: DrizzleSqliteDODatabase<Record<string, never>>;
	/** 集計を含む読み取りなど, クエリビルダで表現できないものに使用 */
	readonly sql: SqlStorage;
	/** 書き込みを行うクエリの回数, 1ジョブあたりの予算のテスト固定用 */
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
				expiresAt: newJob.expiresAt,
				createdAt: newJob.createdAt,
				updatedAt: newJob.createdAt,
				dispatchedAt: null,
				heartbeatAt: null,
				progress: null,
				payload: JSON.stringify(newJob.payload),
				result: null,
				runId: newJob.runId ?? null,
				nodeId: newJob.nodeId ?? null,
			})
			.run();
		this.writes++;
		this.#appendOutbox(newJob.id);
	}

	/**
	 * D1への投影待ちへ追加(ADR-0008)
	 * D1へUPSERTする内容そのものを持たせ、投影側の追加の読み取りを不要化
	 */
	#appendOutbox(id: string): void {
		const row = this.find(id);
		if (!row) return;
		// 試行履歴も同梱, 別経路では冪等性の判定がもう1つ必要(ADR-0028)
		this.db
			.insert(outbox)
			.values({ jobId: id, snapshot: JSON.stringify({ ...row, attempts_log: this.attemptsOf(id) }) })
			.run();
		this.writes++;
	}

	/** 新しい試行から順に返す, 削除は古い方から */
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
	 * 試行1回ぶんの記録
	 * 同じ試行番号の二重報告は内容の置換のみ, 重複配送で行は増えない
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

	/** D1への書き込みが成功してから呼ぶ, 失敗時はカーソルを維持 */
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

	/** スケジューラに渡す稼働中ジョブ, 有界化のためlimitは必須 */
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

	/**
	 * schedule()へ渡す読み取り範囲, 役割ごとに分けて読む(ADR-0019 / ADR-0020, #4)
	 *
	 * 作成順の単一の読み取り範囲では実行中と未到来のジョブが範囲を占有し、後から入った実行可能ジョブが選考に入らない
	 * 実行可能な候補を独立した範囲で読むことで、実行中がlimitを超えても投入候補が範囲に残る
	 * 実行可能ジョブ自体がlimitを超える滞留は解消不能, 作成順の範囲を超えた分は次tick以降で処理
	 *
	 * readyCountは有界判定用, limit到達なら残りがある可能性が高く即座に再実行
	 */
	scheduleWindow(now: number, limit: number): { jobs: JobView[]; readyCount: number } {
		// 実行中(QUEUED/RUNNING): reaperの無応答判定と実行中件数の集計に必要
		const inFlight = this.db
			.select()
			.from(job)
			.where(inArray(job.state, ['QUEUED', 'RUNNING']))
			.orderBy(asc(job.createdAt), asc(job.id))
			.limit(limit)
			.all();
		// 実行可能(SCHEDULED且つrun_after<=now): 投入候補, 実行中と未到来のジョブによる範囲の占有なし
		const ready = this.db
			.select()
			.from(job)
			.where(and(eq(job.state, 'SCHEDULED'), lte(job.runAfter, now)))
			.orderBy(asc(job.createdAt), asc(job.id))
			.limit(limit)
			.all();
		// 未到来(run_after>now)の最も早い1件: futureRunAfterのalarm設定用, 全件は不要
		const future = this.db
			.select()
			.from(job)
			.where(and(eq(job.state, 'SCHEDULED'), gt(job.runAfter, now)))
			.orderBy(asc(job.runAfter))
			.limit(1)
			.all();
		this.reads += 3;
		// 3つは状態/run_afterで互いに素, 重複なし
		const jobs = [...inFlight, ...ready, ...future].map((r) => toView(this.#toJobRow(r)));
		return { jobs, readyCount: ready.length };
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

	/** drizzleのキャメルケースを、投影とテストが読むスネークケースの行へ変換 */
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
			run_id: r.runId,
			node_id: r.nodeId,
		};
	}

	/**
	 * 条件付きの状態遷移, 現在の状態がfromのいずれかと一致する時だけ更新
	 * 一致しなければfalseを返す(重複配送や競合で既に進んでいた場合)
	 * 読んでから書く方式ではなく競合に強い, 書き込みも1回
	 */
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
			/** ジョブ行には残さずRun DOへの通知にだけ含める失敗の理由(ADR-0031) */
			error?: string | null;
			/** performの中で要求された子(ADR-0032) */
			spawns?: readonly SpawnRequest[];
		},
	): boolean {
		for (const state of from) assertTransition(state, to);

		// 遷移のたびに生存報告を消去, 残すと前の試行の報告でreaperの期限が延長
		const set: Record<string, unknown> = { state: to, updatedAt: patch.now, heartbeatAt: null, progress: null };
		if (patch.dispatchedAt !== undefined) set.dispatchedAt = patch.dispatchedAt;
		if (patch.attempts !== undefined) set.attempts = patch.attempts;
		if (patch.runAfter !== undefined) set.runAfter = patch.runAfter;
		// 成功報告と同じ遷移で結果も更新, 書き込み削減で別UPDATEは不使用(#9)
		if (patch.result !== undefined) set.result = patch.result;
		// 現在値を読まずに加算, 成功報告の経路での読み取り増加の回避
		if (patch.countAttempt) set.attempts = sql`${job.attempts} + 1`;

		// 更新できた行を受け取って成否を判定, drizzleのrunに影響行数の返却は無い
		// 宛先も同じreturningで受ける, 遷移のたびの再読なしで通知の要否を判定可能(ADR-0031)
		const updated = this.db
			.update(job)
			.set(set)
			.where(and(eq(job.id, id), inArray(job.state, [...from])))
			.returning({ id: job.id, runId: job.runId, nodeId: job.nodeId })
			.all();
		this.writes++;
		const row = updated[0];
		if (!row) return false;
		this.#appendOutbox(id);
		if (FAILURES.includes(to)) this.#appendFailure(id, to as FailureNotice['state'], patch.error ?? null, patch.now);
		// 終端の捕捉を1箇所に集約, 遷移の呼び出し側ごとの実装は必ずどこかで漏れる
		if (row.runId !== null && row.nodeId !== null && NOTIFIABLE.includes(to)) {
			this.appendNotify(row.runId, {
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

	/**
	 * performerからの生存報告
	 * 実行中のジョブにのみ適用, 終端に達した後の遅れた報告は対象外
	 * 進捗も同じUPDATEで更新, 別文では書き込みが1回増加
	 */
	heartbeat(id: string, now: number, progress: number | null): boolean {
		const set: Record<string, unknown> = { heartbeatAt: now };
		if (progress !== null) set.progress = progress;

		const updated = this.db
			.update(job)
			.set(set)
			.where(and(eq(job.id, id), inArray(job.state, ['QUEUED', 'RUNNING'])))
			.returning({ id: job.id })
			.all();
		this.writes++;
		if (updated.length === 0) return false;
		// 進捗の画面表示には投影が必要, 書き込みの増加は報告側の間隔制限で削減
		this.#appendOutbox(id);
		return true;
	}

	/**
	 * 予約済みジョブの実行時刻と優先度の差し替え
	 *
	 * 状態を変えず`compareAndSet`は使用不可, 遷移表にSCHEDULED->SCHEDULEDは無い(ADR-0012)
	 * 条件付きUPDATEである点は同様で、SCHEDULED以外なら更新行が無く失敗と判定可能
	 */
	reschedule(id: string, runAfter: number, priority: number | undefined, now: number): boolean {
		const set: Record<string, unknown> = { runAfter, updatedAt: now };
		if (priority !== undefined) set.priority = priority;

		const updated = this.db
			.update(job)
			.set(set)
			.where(and(eq(job.id, id), eq(job.state, 'SCHEDULED')))
			.returning({ id: job.id })
			.all();
		this.writes++;
		if (updated.length === 0) return false;
		this.#appendOutbox(id);
		return true;
	}

	/**
	 * 失敗の通知待ちへ追加(#30)
	 * 通知先が読む材料をここで確定, 送信時のジョブの再取得は削除済みで不可
	 */
	#appendFailure(id: string, state: FailureNotice['state'], error: string | null, now: number): void {
		const row = this.find(id);
		if (!row) return;
		const notice: FailureNotice = {
			jobId: id,
			binding: row.binding,
			state,
			attempts: row.attempts,
			maxAttempts: row.max_attempts,
			// 遷移に理由が無ければ直近の試行から取得, reaperの中断は理由を持たない
			error: error ?? this.attemptsOf(id)[0]?.error ?? null,
			runId: row.run_id,
			nodeId: row.node_id,
			failedAt: now,
		};
		this.db
			.insert(failureNotify)
			.values({ jobId: id, payload: JSON.stringify(notice) })
			.run();
		this.writes++;
	}

	failureBatch(limit: number): { seq: number; payload: string }[] {
		const rows = this.db.select().from(failureNotify).orderBy(asc(failureNotify.seq)).limit(limit).all();
		this.reads++;
		return rows.map((row) => ({ seq: row.seq, payload: row.payload }));
	}

	/** 投入が成功してから呼ぶ, 失敗時はカーソルを維持 */
	deleteFailureThrough(seq: number): void {
		this.db.delete(failureNotify).where(lte(failureNotify.seq, seq)).run();
		this.writes++;
	}

	countFailureNotify(): number {
		const row = this.db
			.select({ c: sql<number>`count(*)` })
			.from(failureNotify)
			.get();
		this.reads++;
		return row?.c ?? 0;
	}

	appendNotify(runId: string, event: NodeEvent): void {
		this.db
			.insert(runNotify)
			.values({ runId, event: JSON.stringify(event) })
			.run();
		this.writes++;
	}

	notifyBatch(limit: number): { seq: number; run_id: string; event: string }[] {
		const rows = this.db.select().from(runNotify).orderBy(asc(runNotify.seq)).limit(limit).all();
		this.reads++;
		return rows.map((row) => ({ seq: row.seq, run_id: row.runId, event: row.event }));
	}

	/** 送信が成功してから呼ぶ, 失敗時はカーソルを維持 */
	deleteNotifyThrough(seq: number): void {
		this.db.delete(runNotify).where(lte(runNotify.seq, seq)).run();
		this.writes++;
	}

	countNotify(): number {
		const row = this.db
			.select({ c: sql<number>`count(*)` })
			.from(runNotify)
			.get();
		this.reads++;
		return row?.c ?? 0;
	}

	payloadOf(row: JobRow): unknown {
		return JSON.parse(row.payload);
	}

	/**
	 * 終端に達した古いジョブをDOから削除
	 *
	 * DOのSQLiteは1インスタンス10GBが上限で、行数が増えるとtickのクエリも重くなる
	 * 明細はD1の読み取りモデルに投影済みで、DO側に残し続ける理由が無い
	 *
	 * 投影が滞っていても削除可能
	 * アウトボックスはD1へUPSERTする内容そのものを持ち、ジョブ行への参照なし
	 *
	 * 保持期間は役割の違う2つを別の数字で持つ(ADR-0027)
	 * doneMsは済んだジョブ, failedMsは人手で再開する余地のあるジョブ
	 */
	sweepTerminal(now: number, retention: Retention, limit: number): number {
		const targets = this.db.select({ id: job.id }).from(job).where(sweepable(now, retention)).limit(limit);

		// 先に履歴を削除, ジョブ行を消した後では対象を特定できず参照先の無い行が残る
		this.db.delete(attempt).where(inArray(attempt.jobId, targets)).run();
		this.writes++;

		// 件数はカーソルから取得, returningでは削除した行を全件転送
		const { sql: text, params } = this.db.delete(job).where(inArray(job.id, targets)).toSQL();
		const cursor = this.sql.exec(text, ...(params as SqlStorageValue[]));
		this.writes++;
		return cursor.rowsWritten;
	}

	/**
	 * 削除する対象と次に対象が出る時刻を1回の読み取りで取得
	 * 対象が無いDELETEの実行も書き込みが増加, 読み取りは書き込みより桁で安価
	 *
	 * nextDueAtの返却は無駄な起動の回避用
	 * 失敗ジョブだけが残る状態で短い間隔のalarm設定を続けると、無意味な書き込みが増え続ける
	 *
	 * 3つの集計を1文へまとめた形はクエリビルダで表現できず、生SQLのまま維持
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

	/**
	 * 期限切れの重複排除キー, enqueueが途絶えても残らないようtickでも削除
	 * 件数は非返却, 上限が無く集計すると期限切れの全件を転送
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
		this.reads++;
		return row?.c ?? 0;
	}

	/**
	 * 重複排除の予約(ADR-0021 / ADR-0022)
	 * 取れたらnull,既に取られていれば先行するジョブIDを返す
	 * DOはシングルスレッドで検査と挿入が追加処理なしで不可分
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

	/** 実行時の設定を破棄して静的設定へ戻す用途(#27) */
	deleteSetting(key: string): void {
		this.db.delete(setting).where(eq(setting.key, key)).run();
		this.writes++;
	}

	/** キー別バケットの読み出し(ADR-0045), 対象は投入候補のキーのみで有界 */
	readKeyBuckets(keys: readonly string[]): KeyBuckets {
		if (keys.length === 0) return {};
		const rows = this.db
			.select()
			.from(keyBucket)
			.where(inArray(keyBucket.key, [...keys]))
			.all();
		this.reads++;
		return Object.fromEntries(rows.map((r) => [r.key, { tokens: r.tokens, refilledAt: r.refilledAt }]));
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
		if (keys.length === 0) return;
		this.db
			.delete(keyBucket)
			.where(inArray(keyBucket.key, [...keys]))
			.run();
		this.writes++;
	}

	/** 上限到達行の削除, tokensが0以上の行はintervalMs以内に上限へ回復 */
	sweepKeyBuckets(before: number): void {
		this.db.delete(keyBucket).where(lte(keyBucket.refilledAt, before)).run();
		this.writes++;
	}

	/** perKeyRate無効化後に残った行の削除に利用 */
	clearKeyBuckets(): void {
		this.db.delete(keyBucket).run();
		this.writes++;
	}

	countKeyBuckets(): number {
		const row = this.db
			.select({ c: sql<number>`count(*)` })
			.from(keyBucket)
			.get();
		this.reads++;
		return row?.c ?? 0;
	}
}
