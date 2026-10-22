import { DurableObject } from 'cloudflare:workers';
import { createId } from '@paralleldrive/cuid2';
import { embedJobId, formatJobId, shardName } from '../core/ids.js';
import type { FailOptions } from '../core/api.js';
import { nextAttempt } from '../core/backoff.js';
import { retentionOf } from '../core/retention.js';
import { planDispatch } from '../core/dispatch.js';
import { normalizeTraceparent } from '../core/trace.js';
import type { NodeEvent, SpawnRequest } from '../core/run.js';
import type {
	Backoff,
	BlockedBy,
	Bucket,
	DeliveryGuarantee,
	FailureNotice,
	KeyBuckets,
	Policy,
	Retention,
	SettledNotice,
	SettledTarget,
} from '../core/types.js';
import type { RunStub } from './run.js';
import { systemClock, type Clock } from './clock.js';
import { writeMetrics } from '../analytics/writer.js';
import { project } from '../projection/projector.js';
import { JobRepo, RESULT_MAX_CHARS } from './repo.js';
import type { JobRow } from './schema.js';

function serializeResult(value: unknown): string | null {
	if (value === undefined) return null;
	let text: string | undefined;
	try {
		text = JSON.stringify(value);
	} catch {
		return null;
	}
	if (text === undefined || text.length > RESULT_MAX_CHARS) return null;
	return text;
}

/** payload同梱でconsumerのDO参照不要 */
export type DispatchMessage = {
	jobId: string;
	binding: string;
	attempt: number;
	payload: unknown;
	timeoutMs: number;
	/** at-most-onceは実行前にclaim必須(ADR-0007) */
	claimRequired: boolean;
	/** 実行開始期限, consumerが実行直前に判定 */
	expiresAt: number | null;
	traceparent?: string;
};

export type ShardEnv = {
	TSUMUGI_QUEUE: Queue<DispatchMessage>;
	TSUMUGI_DB: D1Database;
	/** 未設定時メトリクス無効 */
	TSUMUGI_METRICS?: AnalyticsEngineDataset;
	/** flows利用時の完了通知先(ADR-0031) */
	RUN?: DurableObjectNamespace<RunStub>;
	/** 通知投入用の自己参照(#30) */
	JOB_SHARD?: DurableObjectNamespace<FailureNotifyStub>;
};

/** 通知投入用の型, DO本体の型は展開が過剰に深い(#30) */
export interface FailureNotifyStub extends Rpc.DurableObjectBranded {
	enqueueMany(inputs: readonly EnqueueInput[]): Promise<string[]>;
}

/**
 * `requested`は取り消し要求の受理(ADR-0052), 応答か期限で遷移確定
 * `gone`は保持期間経過でDOから削除済み, 一覧はD1由来で残存(ADR-0027)
 */
export type MutationResult = { ok: true; requested?: true } | { ok: false; reason: 'invalid-state' | 'gone' };

export type BulkFailure = { id: string; reason: 'invalid-state' | 'gone' };
type BulkResult = { ok: string[]; failed: BulkFailure[] };

export type ShardSettings = {
	policy?: Partial<Policy>;
	/** COMPLETED / CANCELLEDのDO保持時間, 既定5分 */
	sweepAfterMs?: number;
	/**
	 * FAILED / STALLEDのDO保持時間, 既定7日
	 * 手動リトライ可能期間, 短縮時は一覧にあり再開不能なジョブが発生(ADR-0027)
	 */
	failedRetentionMs?: number;
	/** 失敗通知先binding(#30), nullは解除, 省略は現状維持 */
	failureBinding?: string | null;
	/** 終端通知の宛先と対象(#96), nullは解除, 省略は現状維持 */
	settled?: SettledTarget | null;
};

export type EnqueueInput = {
	binding: string;
	payload: unknown;
	traceparent?: string;
	priority?: number;
	maxAttempts?: number;
	concurrencyKey?: string;
	uniqueKey?: string;
	guarantee?: DeliveryGuarantee;
	timeoutMs?: number;
	backoff?: Backoff;
	delayMs?: number;
	runAt?: number;
	/** 絶対時刻の期限, 経過後は実行せずCANCELLED */
	expiresAt?: number;
	/** 投入時刻からの相対期限, expiresAtと排他 */
	expiresInMs?: number;
	/** uniqueKey予約の保持期間, 経過後は同キーでも新規ジョブ */
	uniqueForMs?: number;
	/** 分割時の投入先決定用(ADR-0011) */
	partitionKey?: string;
	/** Run DOのノード投入用ID, 同ID再投入は既存IDを返却(ADR-0029) */
	id?: string;
	runId?: string;
	nodeId?: string;
};

export const DEFAULT_POLICY: Policy = {
	paused: false,
	concurrency: 100,
	perKeyConcurrency: 1,
	rate: null,
	perKeyRate: null,
	agingIntervalMs: 60_000,
	reaperGraceMs: 30_000,
};

const DEFAULTS: {
	priority: number;
	maxAttempts: number;
	timeoutMs: number;
	backoff: Backoff;
	guarantee: DeliveryGuarantee;
	uniqueForMs: number;
} = {
	priority: 0,
	maxAttempts: 3,
	timeoutMs: 60_000,
	backoff: { kind: 'exponential', baseMs: 1_000, factor: 2, maxMs: 3_600_000, jitter: true },
	guarantee: 'at-least-once',
	uniqueForMs: 24 * 60 * 60 * 1_000,
};

// alarmのwall time上限15分, 残りは次tick
const TICK_LIMIT = 200;

const STAGE_RETRY_MS = 5_000;

// heartbeat, ログの投影待ち, 報告ごとのtick実行回避
const PROGRESS_PROJECTION_DELAY_MS = 3_000;

// D1バッチ上限とtick時間を考慮
const PROJECTION_LIMIT = 200;

const NOTIFY_LIMIT = 200;

// Queuesプロデューサ側のsendBatch上限
const SEND_BATCH_LIMIT = 100;

const SWEEP_LIMIT = 200;

const FAILURE_NOTIFY_LIMIT = 200;

const SETTLED_NOTIFY_LIMIT = 200;

const FAILURE_BINDING_KEY = 'failure_binding';

const BUCKET_KEY = 'rate_bucket';

/**
 * 判断は`core/dispatch.ts`の純粋関数, 本クラスはSQLite入出力のみ(ADR-0018)
 * 時刻は`this.clock`経由, `Date.now()`直接呼び出しはテスト不能
 */
export class TsumugiJobShard extends DurableObject<ShardEnv> {
	/** テスト差し替え用にpublic */
	clock: Clock = systemClock;
	policy: Policy = DEFAULT_POLICY;
	#failureBinding: string | null = null;
	retention: Retention = retentionOf({});

	#repo: JobRepo | undefined;
	#bucket: Bucket = { tokens: Number.POSITIVE_INFINITY, refilledAt: 0 };
	#bucketLoaded = false;
	// falseならkey_bucket空, perKeyRate無効時の確認省略用
	#keyBucketsMaybePresent = true;
	#policyLoaded = false;
	#lastBlocked: BlockedBy = { paused: false, capacity: false, tokens: false, perKey: false, perKeyTokens: false };
	#blockedLoaded = false;

	get repo(): JobRepo {
		if (!this.#repo) this.#repo = new JobRepo(this.ctx.storage);
		return this.#repo;
	}

	/** ルーティング判断はworker側 */
	get shardIndex(): number {
		const name = this.ctx.id.name;
		if (!name) return 0;
		const at = name.lastIndexOf('#');
		if (at < 0) return 0;
		const parsed = Number(name.slice(at + 1));
		return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
	}

	#loadPolicy(): void {
		if (this.#policyLoaded) return;
		const raw = this.repo.readSetting('settings');
		if (raw) {
			const settings = JSON.parse(raw) as ShardSettings;
			this.policy = { ...DEFAULT_POLICY, ...settings.policy };
			this.retention = retentionOf(settings);
		}
		this.#failureBinding = this.repo.readSetting(FAILURE_BINDING_KEY) ?? null;
		this.#policyLoaded = true;
	}

	async configure(settings: ShardSettings): Promise<void> {
		// 実行時設定, 静的設定より優先のpin付与(#6)
		this.#applySettings(settings, true);
	}

	/** configure()同様pin設定で静的設定より優先(#6) */
	async updatePolicy(patch: Partial<Policy>): Promise<Policy> {
		this.#loadPolicy();
		const settings = this.#currentSettings();
		this.#applySettings({ ...settings, policy: { ...settings.policy, ...patch } }, true);
		// 停止時もalarm再設定, 無いと実行中ジョブがreaper未処理で残存
		await this.#armAlarm(this.clock.now());
		return this.policy;
	}

	/** pin解除後は次の投入同梱の静的設定が有効(#6) */
	async resetPolicy(): Promise<void> {
		this.repo.deleteSetting('settings_pinned');
		this.repo.deleteSetting('settings');
		this.policy = DEFAULT_POLICY;
		this.retention = retentionOf({});
		await this.#armAlarm(this.clock.now());
	}

	#currentSettings(): ShardSettings {
		const raw = this.repo.readSetting('settings');
		return raw ? (JSON.parse(raw) as ShardSettings) : { policy: this.policy };
	}

	/**
	 * 運用診断(#10), 外部からの緩和対象判断用(ADR-0009)
	 * activeは稼働中ジョブ数, outboxは投影の滞留数, blockedは直近tickの投入停止要因
	 */
	async diagnostics(): Promise<{ active: number; outbox: number; blocked: BlockedBy; policy: Policy }> {
		this.#loadPolicy();
		this.#loadBlocked();
		// 適用中のpolicy, 画面での変更前後確認用(#27)
		return { active: this.repo.countActive(), outbox: this.repo.countOutbox(), blocked: this.#lastBlocked, policy: this.policy };
	}

	/** scheduleのskip判定用, 削除済みはnull(ADR-0040) */
	async stateOf(jobId: string): Promise<string | null> {
		return this.repo.find(jobId)?.state ?? null;
	}

	// 軸追加前の記録は既定で補完(#27)
	#loadBlocked(): void {
		if (this.#blockedLoaded) return;
		const raw = this.repo.readSetting('last_blocked');
		if (raw) this.#lastBlocked = { ...this.#lastBlocked, ...(JSON.parse(raw) as Partial<BlockedBy>) };
		this.#blockedLoaded = true;
	}

	// SQLite保存, メモリのみではDO退避で上限へ戻り流量超過
	#loadBucket(): void {
		if (this.#bucketLoaded) return;
		const raw = this.repo.readSetting(BUCKET_KEY);
		if (raw) {
			const stored = JSON.parse(raw) as Bucket;
			if (Number.isFinite(stored.tokens) && Number.isFinite(stored.refilledAt)) this.#bucket = stored;
		}
		this.#bucketLoaded = true;
	}

	// tokens上限は保存対象外, 読込時のrefillで同値
	#persistBucket(bucket: Bucket): void {
		const rate = this.policy.rate;
		if (rate === null || bucket.tokens >= rate.tokens) return;
		this.repo.writeSetting(BUCKET_KEY, JSON.stringify(bucket));
	}

	// 対象は使用中の行のみ(ADR-0045)
	// 読込済みで出力に無いキー(上限到達)は削除
	// sweepは選考外で残った行の削除, tokens0以上の行はintervalMs以内に上限到達
	#persistKeyBuckets(read: KeyBuckets, out: KeyBuckets, now: number): void {
		const rate = this.policy.perKeyRate;
		if (rate === null) {
			if (!this.#keyBucketsMaybePresent) return;
			if (this.repo.countKeyBuckets() > 0) this.repo.clearKeyBuckets();
			this.#keyBucketsMaybePresent = false;
			return;
		}
		this.repo.deleteKeyBuckets(Object.keys(read).filter((key) => !Object.hasOwn(out, key)));
		this.repo.writeKeyBuckets(out);
		if (Object.keys(out).length > 0) this.#keyBucketsMaybePresent = true;
		this.repo.sweepKeyBuckets(now - rate.intervalMs);
	}

	#persistBlocked(blocked: BlockedBy): void {
		this.#loadBlocked();
		const encoded = JSON.stringify(blocked);
		if (JSON.stringify(this.#lastBlocked) === encoded) return;
		this.#lastBlocked = blocked;
		this.repo.writeSetting('last_blocked', encoded);
	}

	// pinnedはconfigure()由来, falseはenqueue同梱の静的設定
	// pin後は静的設定を無視, 実行時に制限した流量の次の投入での復元防止(#6)
	// 静的設定への復帰はresetPolicy()
	#applySettings(settings: ShardSettings, pinned: boolean): void {
		this.#loadPolicy();
		// 宛先はpinと独立, pin済みshardにも後から追加した宛先を反映(#30)
		// 省略時は現宛先維持, 投入経路ごとに宛先の有無が別
		if (settings.failureBinding !== undefined) this.#writeFailureBinding(settings.failureBinding);
		if (settings.settled !== undefined) this.repo.writeSettledTarget(settings.settled);
		if (!pinned && this.repo.readSetting('settings_pinned') === '1') return;
		const { failureBinding: _ignored, settled: _ignoredSettled, ...rest } = settings;
		const encoded = JSON.stringify(rest);
		this.policy = { ...DEFAULT_POLICY, ...rest.policy };
		this.retention = retentionOf(rest);
		if (pinned && this.repo.readSetting('settings_pinned') !== '1') this.repo.writeSetting('settings_pinned', '1');
		if (this.repo.readSetting('settings') === encoded) return;
		this.repo.writeSetting('settings', encoded);
	}

	// policyと更新契機が別で別キー(#30)
	#writeFailureBinding(value: string | null): void {
		this.#failureBinding = value;
		const stored = this.repo.readSetting(FAILURE_BINDING_KEY);
		if (value === null) {
			if (stored !== undefined) this.repo.deleteSetting(FAILURE_BINDING_KEY);
			return;
		}
		if (stored !== value) this.repo.writeSetting(FAILURE_BINDING_KEY, value);
	}

	async enqueue(input: EnqueueInput): Promise<string> {
		const [id] = await this.enqueueMany([input]);
		return id as string;
	}

	/** 個別RPCの逐次enqueueはDOの1,000 req/sソフト上限で実測78件/秒 */
	async enqueueMany(inputs: readonly EnqueueInput[], settings?: ShardSettings): Promise<string[]> {
		const traceparents = inputs.map((input) => normalizeTraceparent(input.traceparent));
		const now = this.clock.now();
		this.#loadPolicy();
		// enqueue同梱は静的設定, configure()でpin済みなら無視(#6)
		if (settings) this.#applySettings(settings, false);
		const ids: string[] = [];

		for (const [index, input] of inputs.entries()) {
			const id = input.id ?? formatJobId({ binding: input.binding, shard: this.shardIndex, localId: createId() });

			// ID指定の再投入は既存ID返却, Run DO再送での重複防止
			if (input.id !== undefined && this.repo.find(id)) {
				ids.push(id);
				continue;
			}

			if (input.uniqueKey !== undefined) {
				const expiresAt = now + (input.uniqueForMs ?? DEFAULTS.uniqueForMs);
				const existing = this.repo.reserveUniqueKey(input.uniqueKey, id, expiresAt, now);
				// 衝突は正常系, 先行ジョブID返却で冪等(ADR-0021)
				if (existing !== null) {
					ids.push(existing);
					continue;
				}
			}

			this.repo.insert({
				id,
				binding: input.binding,
				priority: input.priority ?? DEFAULTS.priority,
				maxAttempts: input.maxAttempts ?? DEFAULTS.maxAttempts,
				concurrencyKey: input.concurrencyKey ?? null,
				uniqueKey: input.uniqueKey ?? null,
				guarantee: input.guarantee ?? DEFAULTS.guarantee,
				timeoutMs: input.timeoutMs ?? DEFAULTS.timeoutMs,
				backoff: input.backoff ?? DEFAULTS.backoff,
				runAfter: input.runAt ?? now + (input.delayMs ?? 0),
				expiresAt: input.expiresAt ?? (input.expiresInMs !== undefined ? now + input.expiresInMs : null),
				createdAt: now,
				payload: input.payload,
				traceparent: traceparents[index] ?? null,
				runId: input.runId ?? null,
				nodeId: input.nodeId ?? null,
			});
			ids.push(id);
		}

		await this.#armAlarm(now);
		return ids;
	}

	/**
	 * performerの`ctx.fail`指定はバックオフ計算より優先(#91)
	 * リトライ方針は本メソッドで管理, Queuesの`max_retries`は不使用(ADR-0004)
	 */
	async report(
		jobId: string,
		outcome: { ok: boolean; error?: string; result?: unknown; spawns?: readonly SpawnRequest[]; fail?: FailOptions },
	): Promise<void> {
		const now = this.clock.now();
		const row = this.repo.find(jobId);
		// 受理可否は事前判定, compareAndSet判定では記録が遷移後でoutboxに履歴欠落(ADR-0028)
		if (!row || (row.state !== 'QUEUED' && row.state !== 'RUNNING')) return;

		const serialized = outcome.ok ? serializeResult(outcome.result) : null;
		// runノードの戻り値は後段payload, 保存不能のまま成功では後段にnull(ADR-0035)
		if (outcome.ok && row.run_id !== null && outcome.result !== undefined && serialized === null) {
			await this.report(jobId, { ok: false, error: `cannot store the result (over ${RESULT_MAX_CHARS} chars or not serializable)` });
			return;
		}

		const attempts = row.attempts + 1;
		// 初回成功はジョブ行から導出可能で記録省略, 常時記録は書き込み1回増
		const worthRecording = !outcome.ok || attempts > 1;
		// 遷移でクリアされるdispatched_atを遷移前に記録
		if (worthRecording)
			this.#recordAttempt(
				jobId,
				attempts,
				outcome.ok ? 'COMPLETED' : 'FAILED',
				row.dispatched_at,
				now,
				outcome.ok ? null : (outcome.error ?? null),
			);

		if (outcome.ok) {
			// 成功も試行数に計上, 未計上だと完了ジョブが0回
			this.repo.compareAndSet(jobId, ['QUEUED', 'RUNNING'], 'COMPLETED', {
				now,
				countAttempt: true,
				result: serialized,
				// 失敗試行のspawnは非送信, 再実行時に再要求(ADR-0032)
				...(outcome.spawns ? { spawns: outcome.spawns } : {}),
			});
			await this.#armAlarm(now);
			return;
		}

		// 取り消し要求後の失敗は中断由来, リトライ無しで確定(ADR-0052)
		if (row.cancel_requested_at !== null) {
			this.repo.compareAndSet(jobId, ['QUEUED', 'RUNNING'], 'CANCELLED', { now, attempts, error: outcome.error ?? null });
			await this.#armAlarm(now);
			return;
		}

		// retry: falseは試行回数の残りに関わらず確定(#91)
		const fail = outcome.fail;
		const next =
			fail && 'retry' in fail
				? ({ kind: 'exhausted' } as const)
				: nextAttempt({
						attempts,
						maxAttempts: row.max_attempts,
						backoff: JSON.parse(row.backoff) as Backoff,
						now,
						// 乱数生成はcore外, core純粋性維持(ADR-0018)
						rand: Math.random(),
						...(fail ? { retryAt: fail.retryAt } : {}),
					});

		if (next.kind === 'exhausted') {
			// 理由はノード表示用にRun DOへ送信(ADR-0031)
			this.repo.compareAndSet(jobId, ['QUEUED', 'RUNNING'], 'FAILED', { now, attempts, error: outcome.error ?? null });
			await this.#armAlarm(now);
			return;
		}

		// 期限超過の再試行は予約せず期限切れで終了(ADR-0047)
		if (row.expires_at !== null && next.runAfter >= row.expires_at) {
			this.repo.compareAndSet(jobId, ['QUEUED', 'RUNNING'], 'CANCELLED', { now, attempts });
			await this.#armAlarm(now);
			return;
		}

		this.repo.compareAndSet(jobId, ['QUEUED', 'RUNNING'], 'SCHEDULED', {
			now,
			attempts,
			runAfter: next.runAfter,
			dispatchedAt: null,
		});
		// 同時実行数の解放を即時反映, 再試行時刻は次tickで設定
		await this.#armAlarm(now);
	}

	/**
	 * 所要時間が変動するジョブでもtimeoutMsの最長化不要
	 * 進捗表示用に投影対象, 報告間隔はconsumer側で制限
	 */
	async heartbeat(jobId: string, progress?: number): Promise<{ accepted: boolean; cancelRequested: boolean }> {
		const now = this.clock.now();
		// 画面の進捗100%超過防止
		const clamped = typeof progress === 'number' && Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : null;
		const result = this.repo.heartbeat(jobId, now, clamped);
		if (!result.accepted) return result;
		// 投影用alarm, 無いと進捗表示がreaper期限まで遅延
		await this.#armAlarm(now + PROGRESS_PROJECTION_DELAY_MS);
		return result;
	}

	async log(jobId: string, attempt: number, message: string): Promise<boolean> {
		if (typeof message !== 'string' || !Number.isInteger(attempt) || attempt < 1) return false;
		const now = this.clock.now();
		const result = this.repo.log(jobId, attempt, message, now);
		if (result === 'stored') await this.#armAlarm(now + PROGRESS_PROJECTION_DELAY_MS);
		return result !== 'rejected';
	}

	/**
	 * at-most-onceジョブの実行権, Queuesの重複配送下も条件付きUPDATEで1つに限定(ADR-0007)
	 * 取り消し要求済みは実行せず終了, CAS条件に要求が無く事前確認(ADR-0052)
	 */
	async claim(jobId: string): Promise<boolean> {
		const now = this.clock.now();
		const row = this.repo.find(jobId);
		if (row && row.cancel_requested_at !== null) {
			if (this.repo.compareAndSet(jobId, ['QUEUED'], 'CANCELLED', { now })) await this.#armAlarm(now);
			return false;
		}
		return this.repo.compareAndSet(jobId, ['QUEUED'], 'RUNNING', { now });
	}

	/** consumerからの実行開始前の期限切れ報告(ADR-0047), Queues滞留分も対象 */
	async expire(jobId: string): Promise<void> {
		const now = this.clock.now();
		// 投影用alarm, 無いと静止shardの読み取りモデルが未更新
		if (this.repo.compareAndSet(jobId, ['QUEUED'], 'CANCELLED', { now })) await this.#armAlarm(now);
	}

	/** FAILED / STALLEDは終端だが可逆(ADR-0012) */
	async retry(jobId: string): Promise<MutationResult> {
		const now = this.clock.now();
		const result = this.#retryOne(jobId, now);
		if (result.ok) await this.#armAlarm(now);
		return result;
	}

	#retryOne(jobId: string, now: number): MutationResult {
		// 取り消し要求クリア, 残すと再投入直後にCANCELLED(#95)
		const ok = this.repo.compareAndSet(jobId, ['FAILED', 'STALLED'], 'SCHEDULED', {
			now,
			runAfter: now,
			dispatchedAt: null,
			cancelRequestedAt: null,
		});
		if (ok) return { ok: true };
		// 削除済みと状態違いの区別, 利用者の対応が別(ADR-0027)
		return { ok: false, reason: this.repo.find(jobId) ? 'invalid-state' : 'gone' };
	}

	/**
	 * QUEUED以降は投入済みで対象外
	 * 同じ行の更新でジョブIDとuniqueKey予約を維持
	 */
	async reschedule(jobId: string, patch: { runAfter: number; priority?: number }): Promise<MutationResult> {
		const now = this.clock.now();
		const ok = this.repo.reschedule(jobId, patch.runAfter, patch.priority, now);
		if (ok) {
			// 前倒し時のalarm再設定
			await this.#armAlarm(now);
			return { ok: true };
		}
		return { ok: false, reason: this.repo.find(jobId) ? 'invalid-state' : 'gone' };
	}

	/**
	 * SCHEDULEDは即時CANCELLED, QUEUED/RUNNINGは協調的な取り消し要求を記録(ADR-0052)
	 * 要求はheartbeatの戻り値で通知, 応答か要求後reaperGraceMs経過で確定
	 */
	async cancel(jobId: string): Promise<MutationResult> {
		const now = this.clock.now();
		const result = this.#cancelOne(jobId, now);
		// 投影用alarm, 要求時の応答期限alarmもtickで設定
		if (result.ok) await this.#armAlarm(now);
		return result;
	}

	#cancelOne(jobId: string, now: number): MutationResult {
		if (this.repo.compareAndSet(jobId, ['SCHEDULED'], 'CANCELLED', { now })) return { ok: true };
		if (this.repo.requestCancel(jobId, now)) return { ok: true, requested: true };
		const row = this.repo.find(jobId);
		if (!row) return { ok: false, reason: 'gone' };
		// 要求済みへの再要求は冪等
		if (row.cancel_requested_at !== null && (row.state === 'QUEUED' || row.state === 'RUNNING')) return { ok: true, requested: true };
		return { ok: false, reason: 'invalid-state' };
	}

	/**
	 * 一括リトライ/取り消し, shard単位の1 RPCに集約
	 * 対象は数秒遅れの読み取りモデル由来, 状態はここで再判定
	 */
	async mutateMany(action: 'retry' | 'cancel', jobIds: readonly string[]): Promise<BulkResult> {
		const now = this.clock.now();
		const ok: string[] = [];
		const failed: BulkFailure[] = [];

		for (const jobId of jobIds) {
			// cancelの要求受理分もok, 確定は読み取りモデルで判別(ADR-0052)
			const result = action === 'retry' ? this.#retryOne(jobId, now) : this.#cancelOne(jobId, now);
			if (result.ok) ok.push(jobId);
			else failed.push({ id: jobId, reason: result.reason });
		}

		if (ok.length > 0) await this.#armAlarm(now);
		return { ok, failed };
	}

	async alarm(): Promise<void> {
		try {
			await this.#tick();
		} catch (error) {
			// alarm()の例外はworkerdのリトライが最大6回, 捕捉し次のalarmを必ず設定
			console.error('tsumugi: tick failed', error);
			// tick中に設定された早い予定は維持
			await this.#armAlarm(this.clock.now() + 5_000);
		}
	}

	async #tick(): Promise<void> {
		const now = this.clock.now();
		this.#loadPolicy();
		this.#loadBucket();
		// 実行中がconcurrency未満なら全件取得, 以上なら空き0で影響無し
		const { jobs, readyCount } = this.repo.scheduleWindow(now, TICK_LIMIT, Math.max(TICK_LIMIT, this.policy.concurrency));

		const readyKeys =
			this.policy.perKeyRate === null
				? []
				: [
						...new Set(
							jobs.flatMap((j) => (j.state === 'SCHEDULED' && j.runAfter <= now && j.concurrencyKey !== null ? [j.concurrencyKey] : [])),
						),
					];
		const keyBuckets = this.repo.readKeyBuckets(readyKeys);
		const output = planDispatch({ now, jobs, policy: this.policy, bucket: this.#bucket, keyBuckets });
		this.#bucket = output.bucket;
		this.#persistBucket(output.bucket);
		this.#persistKeyBuckets(keyBuckets, output.keyBuckets, now);
		this.#persistBlocked(output.blocked);

		const messages: MessageSendRequest<DispatchMessage>[] = [];
		for (const decision of output.decisions) {
			switch (decision.type) {
				case 'dispatch': {
					const row = this.repo.find(decision.id);
					if (!row) break;
					// 遷移後に投入, 投入失敗時はQUEUEDのままreaperが処理
					if (!this.repo.compareAndSet(decision.id, ['SCHEDULED'], 'QUEUED', { now, dispatchedAt: now })) break;
					messages.push({
						body: {
							jobId: row.id,
							binding: row.binding,
							attempt: row.attempts + 1,
							payload: this.repo.payloadOf(row),
							timeoutMs: row.timeout_ms,
							claimRequired: row.guarantee === 'at-most-once',
							...(row.traceparent !== null ? { traceparent: row.traceparent } : {}),
							expiresAt: row.expires_at,
						},
					});
					break;
				}
				// expireは無応答の期限切れも対象(ADR-0047)
				case 'expire':
				// cancelは取り消し要求の確定, 応答期限経過とreap後の残留(ADR-0052)
				case 'cancel':
					this.repo.compareAndSet(decision.id, ['SCHEDULED', 'QUEUED', 'RUNNING'], 'CANCELLED', { now });
					break;
				case 'reap':
					this.repo.compareAndSet(decision.id, ['QUEUED', 'RUNNING'], 'SCHEDULED', {
						now,
						attempts: decision.attempts,
						dispatchedAt: null,
					});
					break;
				case 'stall':
					this.repo.compareAndSet(decision.id, ['QUEUED', 'RUNNING'], 'STALLED', { now });
					break;
				case 'fail':
					this.repo.compareAndSet(decision.id, ['QUEUED', 'RUNNING'], 'FAILED', { now });
					break;
			}
		}

		// concurrency>100で1 tickの投入が上限超過(ADR-0009)
		for (let i = 0; i < messages.length; i += SEND_BATCH_LIMIT) {
			await this.env.TSUMUGI_QUEUE.sendBatch(messages.slice(i, i + SEND_BATCH_LIMIT));
		}

		// 後段は相互独立
		let failed = false;
		const stage = async <T>(name: string, run: () => T | Promise<T>, fallback: T): Promise<T> => {
			try {
				return await run();
			} catch (error) {
				console.error(`tsumugi: ${name} failed`, error);
				failed = true;
				return fallback;
			}
		};
		const projected = await stage('project', () => this.#project(), 0);
		const notified = await stage('notifyRuns', () => this.#notifyRuns(), 0);
		const notifiedFailures = await stage('notifyFailures', () => this.#notifyFailures(), 0);
		const notifiedSettled = await stage('notifySettled', () => this.#notifySettled(), 0);
		const { deleted, retryAt } = await stage('sweep', () => this.#sweep(now), { deleted: 0, retryAt: null });

		// 上限到達は残りありとみなし即時再実行
		// トークン待ちは候補不変, 回復時刻のalarmで代替
		// 投入も期限切れも無いtickは同時実行数待ち, 完了報告で再実行(#103)
		// tickのawait中の報告やclaimの投影待ちも確認
		const blockedOnTokens = output.blocked.tokens || output.blocked.perKeyTokens;
		const progressed = output.decisions.some((d) => d.type === 'dispatch' || d.type === 'expire' || d.type === 'cancel');
		const hasMore =
			(readyCount >= TICK_LIMIT && !blockedOnTokens && progressed) ||
			projected >= PROJECTION_LIMIT ||
			deleted >= SWEEP_LIMIT ||
			notified >= NOTIFY_LIMIT ||
			notifiedFailures >= FAILURE_NOTIFY_LIMIT ||
			notifiedSettled >= SETTLED_NOTIFY_LIMIT ||
			// 失敗時は対象外, 障害中のtick反復防止
			(!failed && this.repo.hasOutbox());
		const candidates = [hasMore ? now : output.nextAlarmAt, retryAt, failed ? now + STAGE_RETRY_MS : null].filter(
			(v): v is number => v !== null,
		);
		const next = candidates.length > 0 ? Math.min(...candidates) : null;
		// ハンドラ開始時にalarmは消去済み, 現存分はtick中の設定
		// setAlarmで上書きすると投影が保持期間経過まで遅延
		if (next !== null) await this.#armAlarm(next);
	}

	async #project(): Promise<number> {
		const rows = this.repo.outboxBatch(PROJECTION_LIMIT);
		if (rows.length === 0) return 0;
		await project(this.env.TSUMUGI_DB, rows);
		// 投影は冪等で再処理可(#7)
		this.repo.deleteOutboxThrough(rows[rows.length - 1]!.seq);
		// メトリクスは非冪等でカーソル前進後, 失敗分は欠落しat-most-once(ADR-0016 / #7)
		// 任意機能で失敗は捕捉, tick継続
		try {
			// 明細と同じ行から時系列を記録, sweep後も残存(ADR-0016)
			writeMetrics(
				this.env.TSUMUGI_METRICS,
				rows.map((row) => JSON.parse(row.snapshot) as JobRow),
			);
		} catch (error) {
			console.error('tsumugi: writeMetrics failed', error);
		}
		return rows.length;
	}

	// 失敗時は次tickで再送, Run DO側は重複通知に冪等
	async #notifyRuns(): Promise<number> {
		const rows = this.repo.notifyBatch(NOTIFY_LIMIT);
		if (rows.length === 0) return 0;

		const namespace = this.env.RUN;
		if (!namespace) {
			// RUN binding未設定, 保持して設定後に配送(ADR-0013)
			console.error('tsumugi: cannot notify the run, RUN binding is not configured');
			return 0;
		}

		const groups = new Map<string, NodeEvent[]>();
		for (const row of rows) {
			const events = groups.get(row.run_id);
			const event = JSON.parse(row.event) as NodeEvent;
			if (events) events.push(event);
			else groups.set(row.run_id, [event]);
		}

		await Promise.all([...groups].map(([runId, events]) => namespace.get(namespace.idFromName(runId)).notify(events)));
		this.repo.deleteNotifyThrough(rows[rows.length - 1]!.seq);
		return rows.length;
	}

	// 失敗時は次tickで再送(#30)
	#notifyFailures(): Promise<number> {
		return this.#sendNotices<FailureNotice>({
			rows: this.repo.failureBatch(FAILURE_NOTIFY_LIMIT),
			target: () => this.#failureBinding,
			deleteThrough: (seq) => this.repo.deleteFailureThrough(seq),
			// 通知ジョブ自身の失敗は対象外, 循環防止(#30)
			skip: (notice, target) => notice.binding === target,
			// 元ID全体を埋め込み形式へ変換, ローカル部のみではbinding間で衝突
			localIdOf: (notice) => `failure-${embedJobId(notice.jobId)}-${notice.attempts}`,
			label: 'failure',
		});
	}

	// 失敗時は次tickで再送(#96)
	#notifySettled(): Promise<number> {
		return this.#sendNotices<SettledNotice>({
			rows: this.repo.settledBatch(SETTLED_NOTIFY_LIMIT),
			target: () => this.repo.settledTarget()?.binding ?? null,
			deleteThrough: (seq) => this.repo.deleteSettledThrough(seq),
			// 宛先自身とonFailure宛先の遷移は対象外, 相互通知の連鎖防止(#96)
			skip: (notice, target) => notice.binding === target || notice.binding === this.#failureBinding,
			// 状態もIDに含有, リトライ後の同attemptsの別終端を区別
			localIdOf: (notice) => `settled-${embedJobId(notice.jobId)}-${notice.attempts}-${notice.state.toLowerCase()}`,
			label: 'settled job',
		});
	}

	async #sendNotices<N extends { binding: string }>(spec: {
		rows: { seq: number; payload: string }[];
		target: () => string | null;
		deleteThrough: (seq: number) => void;
		skip: (notice: N, target: string) => boolean;
		localIdOf: (notice: N) => string;
		label: string;
	}): Promise<number> {
		const { rows } = spec;
		if (rows.length === 0) return 0;
		const last = rows[rows.length - 1]!.seq;

		const target = spec.target();
		if (target === null) {
			// 宛先未設定中の記録は破棄, 設定後の古い通知の一括配送防止
			spec.deleteThrough(last);
			return rows.length;
		}

		const inputs: EnqueueInput[] = rows
			.map((row) => JSON.parse(row.payload) as N)
			.filter((notice) => !spec.skip(notice, target))
			.map((notice) => ({
				binding: target,
				payload: notice,
				// 固定IDで再送時の二重投入防止(ADR-0029)
				id: formatJobId({ binding: target, shard: 0, localId: spec.localIdOf(notice) }),
			}));

		if (inputs.length > 0) {
			// 通知先は非分割前提でshard 0へ送信
			const namespace = this.env.JOB_SHARD;
			if (!namespace) {
				// JOB_SHARD binding未設定, 保持して設定後に配送(ADR-0013)
				console.error(`tsumugi: cannot notify the ${spec.label}, JOB_SHARD binding is not configured`);
				return 0;
			}
			await namespace.get(namespace.idFromName(shardName(target, 0))).enqueueMany(inputs);
		}
		spec.deleteThrough(last);
		return rows.length;
	}

	#sweep(now: number): { deleted: number; retryAt: number | null } {
		// 対象有無はSQLiteから取得, メモリ保持ではDOエビクト後に削除停止
		const state = this.repo.sweepState(now, this.retention);
		if (state.uniqueKeys) this.repo.sweepExpiredUniqueKeys(now);
		const deleted = state.jobs ? this.repo.sweepTerminal(now, this.retention, SWEEP_LIMIT) : 0;

		// 次の削除対象の時刻を返却, 稼働中ジョブが無いとalarm未設定で削除不能
		// 一定間隔起動は失敗ジョブのみ残存時に無駄な書き込み増
		const next = deleted > 0 ? this.repo.sweepState(now, this.retention).nextDueAt : state.nextDueAt;
		return { deleted, retryAt: next === null ? null : Math.max(next, now + 1_000) };
	}

	// 遷移前に記録, 同じ投影でD1へ反映
	#recordAttempt(jobId: string, attempt: number, state: string, startedAt: number | null, finishedAt: number, error: string | null): void {
		this.repo.recordAttempt({ job_id: jobId, attempt, state, started_at: startedAt, finished_at: finishedAt, error });
	}

	async #armAlarm(at: number): Promise<void> {
		const current = await this.ctx.storage.getAlarm();
		if (current === null || current > at) await this.ctx.storage.setAlarm(at);
	}
}
