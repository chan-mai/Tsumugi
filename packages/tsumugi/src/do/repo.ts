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
import { chunk, columnList, placeholders, valuesOf } from './bind.js';
import { applySchema, COLUMNS, TERMINAL_INDEX_WHERE, type AttemptRow, type JobRow } from './schema.js';

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

const JOB_COLUMNS = columnList(COLUMNS.job);
const IN_FLIGHT = placeholders(2);

// sweepStateのSQLと同条件を維持, 部分索引条件は各分岐内でMULTI-INDEX OR維持
const SWEEPABLE = `(state IN ('COMPLETED', 'CANCELLED') AND updated_at < ? AND ${TERMINAL_INDEX_WHERE})
	OR (state IN ('FAILED', 'STALLED') AND updated_at < ? AND ${TERMINAL_INDEX_WHERE})`;

// 列名は呼び出し側の固定値のみ
const assignments = (set: Record<string, SqlStorageValue>) =>
	Object.keys(set)
		.map((column) => `${column} = ?`)
		.join(', ');

/** 状態遷移は条件付きUPDATEの`returning`で成否判定, 読んでから書く方式は不使用 */
export class JobRepo {
	readonly sql: SqlStorage;
	/** 1ジョブあたり書き込み予算のテスト用 */
	writes = 0;
	// undefinedは未読込
	#settledTarget: SettledTarget | null | undefined;
	// ジョブIDから未投影outbox行のseq, DO退避で消失時は挿入
	#pendingOutbox = new Map<string, number>();

	constructor(storage: DurableObjectStorage) {
		this.sql = storage.sql;
		applySchema(storage.sql);
	}

	// 呼び出し毎にthis.sql参照, テストの差し替え対象
	#all<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]): T[] {
		return this.sql.exec<T>(query, ...bindings).toArray();
	}

	#first<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]): T | undefined {
		return this.#all<T>(query, ...bindings)[0];
	}

	#write(query: string, ...bindings: SqlStorageValue[]): number {
		const cursor = this.sql.exec(query, ...bindings);
		this.writes++;
		return cursor.rowsWritten;
	}

	insert(newJob: NewJob): void {
		this.#write(
			`INSERT INTO job (${JOB_COLUMNS}) VALUES (${placeholders(COLUMNS.job.length)})`,
			...valuesOf(COLUMNS.job, {
				id: newJob.id,
				binding: newJob.binding,
				state: 'SCHEDULED',
				priority: newJob.priority,
				attempts: 0,
				max_attempts: newJob.maxAttempts,
				concurrency_key: newJob.concurrencyKey,
				unique_key: newJob.uniqueKey,
				guarantee: newJob.guarantee,
				timeout_ms: newJob.timeoutMs,
				backoff: JSON.stringify(newJob.backoff),
				run_after: newJob.runAfter,
				expires_at: newJob.expiresAt,
				created_at: newJob.createdAt,
				updated_at: newJob.createdAt,
				dispatched_at: null,
				heartbeat_at: null,
				progress: null,
				payload: JSON.stringify(newJob.payload),
				result: null,
				traceparent: newJob.traceparent ?? null,
				cancel_requested_at: null,
				run_id: newJob.runId ?? null,
				node_id: newJob.nodeId ?? null,
			}),
		);
		this.#appendOutbox(newJob.id);
	}

	// UPSERT内容そのもので投影側の追加読み取り不要(ADR-0008)
	#appendOutbox(id: string): { row: JobRow; attempts: AttemptRow[] } | null {
		const row = this.find(id);
		if (!row) return null;
		const attempts = this.attemptsOf(id);
		// 試行履歴も同梱, 別経路は冪等性判定が別途必要(ADR-0028)
		const snapshot = JSON.stringify({ ...row, attempts_log: attempts, logs: this.logsOf(id) });
		// 未投影行は上書き, 挿入とsqlite_sequence更新と削除の書き込み削減
		const pending = this.#pendingOutbox.get(id);
		// 終端の行は上書き対象外, 再試行時のメトリクス欠落防止
		const terminal = TERMINAL_STATES.includes(row.state as JobState);
		if (pending !== undefined) {
			const updated = this.#all(`UPDATE outbox SET snapshot = ? WHERE seq = ? RETURNING seq`, snapshot, pending);
			this.writes++;
			if (updated.length > 0) {
				if (terminal) this.#pendingOutbox.delete(id);
				return { row, attempts };
			}
		}
		const inserted = this.#first<{ seq: number }>(`INSERT INTO outbox (job_id, snapshot) VALUES (?, ?) RETURNING seq`, id, snapshot);
		this.writes++;
		if (inserted && !terminal) this.#pendingOutbox.set(id, inserted.seq);
		else this.#pendingOutbox.delete(id);
		return { row, attempts };
	}

	attemptsOf(jobId: string): AttemptRow[] {
		return this.#all<AttemptRow>(
			`SELECT ${columnList(COLUMNS.attempt)} FROM attempt WHERE job_id = ? ORDER BY attempt DESC LIMIT ?`,
			jobId,
			ATTEMPT_KEEP,
		);
	}

	logsOf(jobId: string): JobLogEntry[] {
		return this.#all<JobLogEntry>(
			`SELECT attempt, timestamp, message FROM job_log WHERE job_id = ? ORDER BY seq ASC LIMIT ?`,
			jobId,
			LOG_KEEP,
		);
	}

	log(id: string, attemptNumber: number, message: string, now: number): 'stored' | 'throttled' | 'rejected' {
		const row = this.find(id);
		if (!row || (row.state !== 'QUEUED' && row.state !== 'RUNNING') || row.attempts + 1 !== attemptNumber) return 'rejected';
		const history = this.#first<{ count: number; last_at: number | null }>(
			`SELECT count(*) AS count, max(timestamp) AS last_at FROM job_log WHERE job_id = ?`,
			id,
		);
		if (history?.last_at !== null && history?.last_at !== undefined && now - history.last_at < LOG_MIN_INTERVAL_MS) return 'throttled';
		this.#write(
			`INSERT INTO job_log (job_id, attempt, timestamp, message) VALUES (?, ?, ?, ?)`,
			id,
			attemptNumber,
			now,
			message.slice(0, LOG_MAX_CHARS),
		);
		const excess = (history?.count ?? 0) + 1 - LOG_KEEP;
		if (excess > 0) {
			this.#write(`DELETE FROM job_log WHERE seq IN (SELECT seq FROM job_log WHERE job_id = ? ORDER BY seq ASC LIMIT ?)`, id, excess);
		}
		this.#appendOutbox(id);
		return 'stored';
	}

	/** 同試行番号は置換, 重複配送でも1行 */
	recordAttempt(record: AttemptRow): void {
		this.#write(
			`INSERT INTO attempt (job_id, attempt, state, started_at, finished_at, error) VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT (job_id, attempt) DO UPDATE SET
				state = excluded.state, started_at = excluded.started_at, finished_at = excluded.finished_at, error = excluded.error`,
			record.job_id,
			record.attempt,
			record.state,
			record.started_at,
			record.finished_at,
			record.error === null ? null : record.error.slice(0, ERROR_MAX_CHARS),
		);
	}

	outboxBatch(limit: number): { seq: number; job_id: string; snapshot: string }[] {
		const rows = this.#all<{ seq: number; job_id: string; snapshot: string }>(
			`SELECT seq, job_id, snapshot FROM outbox ORDER BY seq ASC LIMIT ?`,
			limit,
		);
		// 投影中の行は上書き対象外, D1書き込み待機中の遷移が削除で消失
		for (const r of rows) if (this.#pendingOutbox.get(r.job_id) === r.seq) this.#pendingOutbox.delete(r.job_id);
		return rows;
	}

	/** D1書き込み成功後専用 */
	deleteOutboxThrough(seq: number): void {
		this.#write(`DELETE FROM outbox WHERE seq <= ?`, seq);
	}

	countOutbox(): number {
		return this.#first<{ c: number }>(`SELECT count(*) AS c FROM outbox`)?.c ?? 0;
	}

	hasOutbox(): boolean {
		return this.#first(`SELECT seq FROM outbox LIMIT 1`) !== undefined;
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
		const inFlight = this.#all<JobRow>(
			`SELECT ${JOB_COLUMNS} FROM job WHERE state IN (${IN_FLIGHT}) ORDER BY created_at ASC, id ASC LIMIT ?`,
			'QUEUED',
			'RUNNING',
			inFlightLimit,
		);
		// 実行可能: 投入候補, job_dueで到来順に取得し滞留時もlimit件まで(#104)
		const ready = this.#all<JobRow>(
			`SELECT ${JOB_COLUMNS} FROM job WHERE state = ? AND run_after <= ? ORDER BY run_after ASC, id ASC LIMIT ?`,
			'SCHEDULED',
			now,
			limit,
		);
		// 未到来の最早1件: alarm設定用
		const future = this.#all<JobRow>(
			`SELECT ${JOB_COLUMNS} FROM job WHERE state = ? AND run_after > ? ORDER BY run_after ASC LIMIT 1`,
			'SCHEDULED',
			now,
		);
		// 3つは状態/run_afterで互いに素
		const jobs = [...inFlight, ...ready, ...future].map(toView);
		return { jobs, readyCount: ready.length };
	}

	countActive(): number {
		return (
			this.#first<{ c: number }>(`SELECT count(*) AS c FROM job WHERE state IN (${placeholders(ACTIVE_STATES.length)})`, ...ACTIVE_STATES)
				?.c ?? 0
		);
	}

	find(id: string): JobRow | undefined {
		return this.#first<JobRow>(`SELECT ${JOB_COLUMNS} FROM job WHERE id = ?`, id);
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
		const set: Record<string, SqlStorageValue> = { state: to, updated_at: patch.now, heartbeat_at: null, progress: null };
		if (patch.dispatchedAt !== undefined) set.dispatched_at = patch.dispatchedAt;
		if (patch.attempts !== undefined && !patch.countAttempt) set.attempts = patch.attempts;
		if (patch.runAfter !== undefined) set.run_after = patch.runAfter;
		if (patch.result !== undefined) set.result = patch.result;
		// 要求は既定で維持, reap後の再投入防止(#95)
		if (patch.cancelRequestedAt !== undefined) set.cancel_requested_at = patch.cancelRequestedAt;
		const increment = patch.countAttempt ? ', attempts = attempts + 1' : '';

		// returningで成否と宛先を同時取得(ADR-0031)
		const row = this.#first<{ run_id: string | null; node_id: string | null }>(
			`UPDATE job SET ${assignments(set)}${increment} WHERE id = ? AND state IN (${placeholders(from.length)}) RETURNING run_id, node_id`,
			...Object.values(set),
			id,
			...from,
		);
		this.writes++;
		if (!row) return false;
		const current = this.#appendOutbox(id);
		if (current && FAILURE_STATES.includes(to)) {
			this.#appendFailure(current.row, current.attempts, to as FailureNotice['state'], patch.error ?? null, patch.now);
		}
		if (current && TERMINAL_STATES.includes(to)) {
			this.#appendSettled(current.row, current.attempts, to as SettledState, patch.error ?? null, patch.now);
		}
		// 終端検出を1箇所に集約, 呼び出し側ごとの実装は漏れの原因
		if (row.run_id !== null && row.node_id !== null && TERMINAL_STATES.includes(to)) {
			this.appendRunNotify(row.run_id, {
				nodeId: row.node_id,
				jobId: id,
				state: to as NodeEvent['state'],
				result: patch.result ?? null,
				error: patch.error ?? null,
				...(patch.spawns && patch.spawns.length > 0 ? { spawns: patch.spawns } : {}),
			});
		}
		return true;
	}

	/** `projected`: outbox追記の有無, 進捗不変の場合省略 */
	heartbeat(id: string, now: number, progress: number | null): { accepted: boolean; cancelRequested: boolean; projected: boolean } {
		const set: Record<string, SqlStorageValue> = { heartbeat_at: now };
		if (progress !== null) set.progress = progress;
		const previous =
			progress === null ? undefined : this.#first<{ progress: number | null }>(`SELECT progress FROM job WHERE id = ?`, id)?.progress;

		const row = this.#first<{ cancel_requested_at: number | null }>(
			`UPDATE job SET ${assignments(set)} WHERE id = ? AND state IN (${IN_FLIGHT}) RETURNING cancel_requested_at`,
			...Object.values(set),
			id,
			'QUEUED',
			'RUNNING',
		);
		this.writes++;
		if (!row) return { accepted: false, cancelRequested: false, projected: false };
		// 進捗表示用の投影, heartbeat_atはD1に無く進捗変化時のみ
		const projected = progress !== null && progress !== previous;
		if (projected) this.#appendOutbox(id);
		return { accepted: true, cancelRequested: row.cancel_requested_at !== null, projected };
	}

	requestCancel(id: string, now: number): boolean {
		const updated = this.#all(
			`UPDATE job SET cancel_requested_at = ?, updated_at = ?
			WHERE id = ? AND state IN (${IN_FLIGHT}) AND cancel_requested_at IS NULL RETURNING id`,
			now,
			now,
			id,
			'QUEUED',
			'RUNNING',
		);
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
		const set: Record<string, SqlStorageValue> = { run_after: runAfter, updated_at: now };
		if (priority !== undefined) set.priority = priority;

		const updated = this.#all(
			`UPDATE job SET ${assignments(set)} WHERE id = ? AND state = ? AND cancel_requested_at IS NULL RETURNING id`,
			...Object.values(set),
			id,
			'SCHEDULED',
		);
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
		this.#write(`INSERT INTO failure_notify (job_id, payload) VALUES (?, ?)`, row.id, JSON.stringify(notice));
	}

	failureBatch(limit: number): { seq: number; payload: string }[] {
		return this.#all<{ seq: number; payload: string }>(`SELECT seq, payload FROM failure_notify ORDER BY seq ASC LIMIT ?`, limit);
	}

	/** 投入成功後専用 */
	deleteFailureThrough(seq: number): void {
		this.#write(`DELETE FROM failure_notify WHERE seq <= ?`, seq);
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
		this.#write(`INSERT INTO settled_notify (job_id, payload) VALUES (?, ?)`, row.id, JSON.stringify(notice));
	}

	settledBatch(limit: number): { seq: number; payload: string }[] {
		return this.#all<{ seq: number; payload: string }>(`SELECT seq, payload FROM settled_notify ORDER BY seq ASC LIMIT ?`, limit);
	}

	/** 投入成功後専用 */
	deleteSettledThrough(seq: number): void {
		this.#write(`DELETE FROM settled_notify WHERE seq <= ?`, seq);
	}

	countSettledNotify(): number {
		return this.#first<{ c: number }>(`SELECT count(*) AS c FROM settled_notify`)?.c ?? 0;
	}

	appendRunNotify(runId: string, event: NodeEvent): void {
		this.#write(`INSERT INTO run_notify (run_id, event) VALUES (?, ?)`, runId, JSON.stringify(event));
	}

	runNotifyBatch(limit: number): { seq: number; run_id: string; event: string }[] {
		return this.#all<{ seq: number; run_id: string; event: string }>(
			`SELECT seq, run_id, event FROM run_notify ORDER BY seq ASC LIMIT ?`,
			limit,
		);
	}

	/** 送信成功後専用 */
	deleteRunNotifyThrough(seq: number): void {
		this.#write(`DELETE FROM run_notify WHERE seq <= ?`, seq);
	}

	payloadOf(row: JobRow): unknown {
		return JSON.parse(row.payload);
	}

	/**
	 * DOのSQLite上限10GBとtickクエリ負荷対策
	 * outboxはジョブ行非参照で投影滞留中も削除可能
	 */
	sweepTerminal(now: number, retention: Retention, limit: number): number {
		const targets = `SELECT id FROM job WHERE ${SWEEPABLE} LIMIT ?`;
		const bindings = [now - retention.sweepAfterMs, now - retention.failedRetentionMs, limit];

		// ジョブ行より先に履歴削除, 後では対象特定不能
		this.#write(`DELETE FROM attempt WHERE job_id IN (${targets})`, ...bindings);
		this.#write(`DELETE FROM job_log WHERE job_id IN (${targets})`, ...bindings);
		// 件数はカーソルから取得, returningは全行転送
		return this.#write(`DELETE FROM job WHERE id IN (${targets})`, ...bindings);
	}

	/**
	 * 削除対象の有無と次回時刻を1回の読み取りで取得, 対象無しDELETEも書き込みに計上
	 * nextDueAtは失敗ジョブのみ残存時の短間隔alarm回避用
	 * next_dueは状態別MINでjob_terminalの先頭1件から取得(#104), 多引数min()はNULL含有でNULL
	 */
	sweepState(now: number, retention: Retention): { jobs: boolean; uniqueKeys: boolean; nextDueAt: number | null } {
		const row = this.sql
			.exec<{ jobs: number; unique_keys: number; next_due: number | null }>(
				`SELECT
					EXISTS(SELECT 1 FROM job WHERE
						(state IN ('COMPLETED', 'CANCELLED') AND updated_at < ?1 AND ${TERMINAL_INDEX_WHERE})
						OR (state IN ('FAILED', 'STALLED') AND updated_at < ?2 AND ${TERMINAL_INDEX_WHERE})) AS jobs,
					EXISTS(SELECT 1 FROM unique_key WHERE expires_at <= ?3) AS unique_keys,
					(SELECT MIN(due) FROM (
						SELECT MIN(updated_at) + ?4 AS due FROM job WHERE state = 'COMPLETED' AND ${TERMINAL_INDEX_WHERE}
						UNION ALL SELECT MIN(updated_at) + ?4 FROM job WHERE state = 'CANCELLED' AND ${TERMINAL_INDEX_WHERE}
						UNION ALL SELECT MIN(updated_at) + ?5 FROM job WHERE state = 'FAILED' AND ${TERMINAL_INDEX_WHERE}
						UNION ALL SELECT MIN(updated_at) + ?5 FROM job WHERE state = 'STALLED' AND ${TERMINAL_INDEX_WHERE})) AS next_due`,
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
		this.#write(`DELETE FROM unique_key WHERE expires_at <= ?`, now);
	}

	countJobs(): number {
		return this.#first<{ c: number }>(`SELECT count(*) AS c FROM job`)?.c ?? 0;
	}

	/**
	 * 重複排除キー予約(ADR-0021 / ADR-0022), 成功時null, 予約済みなら先行ジョブID
	 * DOはシングルスレッドで検査と挿入が不可分
	 */
	reserveUniqueKey(key: string, jobId: string, expiresAt: number, now: number): string | null {
		// 他キーの期限切れはtickで削除
		this.#write(`DELETE FROM unique_key WHERE key = ? AND expires_at <= ?`, key, now);

		const inserted = this.#all(
			`INSERT INTO unique_key (key, job_id, expires_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING RETURNING key`,
			key,
			jobId,
			expiresAt,
		);
		this.writes++;
		if (inserted.length > 0) return null;

		return this.#first<{ job_id: string }>(`SELECT job_id FROM unique_key WHERE key = ?`, key)?.job_id ?? null;
	}

	readSetting(key: string): string | undefined {
		return this.#first<{ value: string }>(`SELECT value FROM setting WHERE key = ?`, key)?.value;
	}

	writeSetting(key: string, value: string): void {
		this.#write(`INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, value);
	}

	deleteSetting(key: string): void {
		this.#write(`DELETE FROM setting WHERE key = ?`, key);
	}

	/** 投入候補キーのみで有界(ADR-0045) */
	readKeyBuckets(keys: readonly string[]): KeyBuckets {
		const buckets: KeyBuckets = Object.create(null);
		for (const part of chunk(keys, 1)) {
			const rows = this.#all<{ key: string; tokens: number; refilled_at: number }>(
				`SELECT key, tokens, refilled_at FROM key_bucket WHERE key IN (${placeholders(part.length)})`,
				...part,
			);
			for (const r of rows) buckets[r.key] = { tokens: r.tokens, refilledAt: r.refilled_at };
		}
		return buckets;
	}

	writeKeyBuckets(buckets: KeyBuckets): void {
		for (const [key, b] of Object.entries(buckets)) {
			this.#write(
				`INSERT INTO key_bucket (key, tokens, refilled_at) VALUES (?, ?, ?)
				ON CONFLICT (key) DO UPDATE SET tokens = excluded.tokens, refilled_at = excluded.refilled_at`,
				key,
				b.tokens,
				b.refilledAt,
			);
		}
	}

	deleteKeyBuckets(keys: readonly string[]): void {
		for (const part of chunk(keys, 1)) {
			this.#write(`DELETE FROM key_bucket WHERE key IN (${placeholders(part.length)})`, ...part);
		}
	}

	/** tokens0以上はintervalMs以内に上限到達 */
	sweepKeyBuckets(before: number): void {
		this.#write(`DELETE FROM key_bucket WHERE refilled_at <= ?`, before);
	}

	/** perKeyRate無効化後の残存行削除用 */
	clearKeyBuckets(): void {
		this.#write(`DELETE FROM key_bucket`);
	}

	countKeyBuckets(): number {
		return this.#first<{ c: number }>(`SELECT count(*) AS c FROM key_bucket`)?.c ?? 0;
	}
}
