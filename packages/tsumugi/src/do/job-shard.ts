import { DurableObject } from 'cloudflare:workers';
import { createId } from '@paralleldrive/cuid2';
import { embedJobId, formatJobId, shardName } from '../core/ids.js';
import { nextAttempt } from '../core/backoff.js';
import { schedule } from '../core/schedule.js';
import type { NodeEvent, SpawnRequest } from '../core/run.js';
import type { Backoff, BlockedBy, Bucket, DeliveryGuarantee, FailureNotice, KeyBuckets, Policy, Retention } from '../core/types.js';
import type { RunStub } from './run.js';
import { systemClock, type Clock } from './clock.js';
import { writeMetrics } from '../analytics/writer.js';
import { project } from '../projection/projector.js';
import { JobRepo, RESULT_MAX_CHARS } from './repo.js';
import type { JobRow } from './schema.js';

/**
 * performの戻り値を保存用のJSON文字列へ変換(#9)
 * 戻り値なし/非直列化/上限超過はnull, 大きい結果はperformerがR2等へ書く運用
 */
function serializeResult(value: unknown): string | null {
	if (value === undefined) return null;
	let text: string | undefined;
	try {
		text = JSON.stringify(value);
	} catch {
		// 循環参照等の直列化不能な値は保存対象外
		return null;
	}
	if (text === undefined || text.length > RESULT_MAX_CHARS) return null;
	return text;
}

/** Queuesへ送るメッセージ, ペイロード同梱でconsumerによるDO参照が不要 */
export type DispatchMessage = {
	jobId: string;
	binding: string;
	attempt: number;
	payload: unknown;
	timeoutMs: number;
	/** at-most-onceのジョブは実行前にclaimの取得が必要(ADR-0007) */
	claimRequired: boolean;
};

export type ShardEnv = {
	TSUMUGI_QUEUE: Queue<DispatchMessage>;
	TSUMUGI_DB: D1Database;
	/** 任意, 未設定ならメトリクスは無効 */
	TSUMUGI_METRICS?: AnalyticsEngineDataset;
	/** 任意, flowsを使う場合のみ必要な完了通知の宛先(ADR-0031) */
	RUN?: DurableObjectNamespace<RunStub>;
	/** 失敗の通知先への投入で自分自身を参照(#30) */
	JOB_SHARD?: DurableObjectNamespace<FailureNotifyStub>;
};

/** 失敗の通知先へ投入する面, DO本体の型を使うと型の展開が過剰に深い(#30) */
export interface FailureNotifyStub extends Rpc.DurableObjectBranded {
	enqueueMany(inputs: readonly EnqueueInput[]): Promise<string[]>;
}

/**
 * retry / cancelの結果
 * `gone`は保持期間を過ぎてDOから消えた状態, 一覧はD1由来で画面には残存(ADR-0027)
 */
export type MutationResult = { ok: true } | { ok: false; reason: 'invalid-state' | 'gone' };

/** まとめて処理した結果, 失敗の理由は個別のretry / cancelと同じ区別 */
export type BulkFailure = { id: string; reason: 'invalid-state' | 'gone' };
export type BulkResult = { ok: string[]; failed: BulkFailure[] };

/** DOに持たせる設定,流量制御と保持期間 */
export type ShardSettings = {
	policy?: Partial<Policy>;
	/** 済んだジョブ(COMPLETED / CANCELLED)をDOに残す時間, 既定5分 */
	sweepAfterMs?: number;
	/**
	 * 失敗ジョブ(FAILED / STALLED)をDOに残す時間, 既定7日
	 * 手動リトライを受け付ける期間, 短くすると一覧に見えるのに再開できないジョブが発生(ADR-0027)
	 */
	failedRetentionMs?: number;
	/** 失敗を知らせる先のbinding(#30), nullは解除, 省略は現状維持 */
	failureBinding?: string | null;
};

export type EnqueueInput = {
	binding: string;
	payload: unknown;
	priority?: number;
	maxAttempts?: number;
	concurrencyKey?: string;
	uniqueKey?: string;
	guarantee?: DeliveryGuarantee;
	timeoutMs?: number;
	backoff?: Backoff;
	delayMs?: number;
	runAt?: number;
	/** uniqueKeyの予約を保持する期間, 経過後は同じキーでも新規ジョブ */
	uniqueForMs?: number;
	/** 分割している場合の投入先の決定に使う(ADR-0011) */
	partitionKey?: string;
	/**
	 * ジョブIDの指定
	 * Run DOがノードを投入する時に使用, 同じIDの再投入は既存を返し二重投入を防止(ADR-0029)
	 */
	id?: string;
	/** 完了をどのrunのどのノードとして知らせるか(ADR-0031) */
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

/**
 * 1 tickで扱うジョブ数の上限
 * alarmのwall time上限は15分, tickは必ず有界にし残りは次のtickへ送る
 */
const TICK_LIMIT = 200;

/** 1回の投影で処理するアウトボックスの上限, D1のバッチ上限とtickの時間に配慮 */
const PROJECTION_LIMIT = 200;

/** 1回のtickでRun DOへ送る通知の上限(ADR-0031) */
const NOTIFY_LIMIT = 200;

/** Cloudflare Queuesのプロデューサ側上限, 1回のsendBatchは100件まで, これを超えるTICK_LIMITぶんは分割 */
const SEND_BATCH_LIMIT = 100;

/** 1 tickで削除する終端ジョブの上限, tickを有界に維持 */
const SWEEP_LIMIT = 200;

/** 1回のtickで投入する失敗の通知の上限(#30) */
const FAILURE_NOTIFY_LIMIT = 200;

/** 宛先を置く設定のキー(#30) */
const FAILURE_BINDING_KEY = 'failure_binding';

const BUCKET_KEY = 'rate_bucket';

/** 済んだジョブをDOに残す時間, 投影が追いつく余裕を考慮し既定5分 */
const DEFAULT_SWEEP_AFTER_MS = 5 * 60 * 1000;

/**
 * 失敗ジョブをDOに残す時間, 既定7日
 * D1の読み取りモデルの既定と揃える, 揃えないと一覧に見えるのに再開できないジョブが発生(ADR-0027)
 */
export const DEFAULT_FAILED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function retentionOf(settings: ShardSettings): Retention {
	return {
		doneMs: settings.sweepAfterMs ?? DEFAULT_SWEEP_AFTER_MS,
		failedMs: settings.failedRetentionMs ?? DEFAULT_FAILED_RETENTION_MS,
	};
}

/**
 * ジョブの調停役(ADR-0002)
 *
 * 判断は`core/schedule.ts`の純粋関数が担当、ここはSQLiteとの仲介のみ(ADR-0018)
 * 時刻は必ず`this.clock`経由で取得, `Date.now()`の直接呼び出しはテスト不能
 */
export class TsumugiJobShard extends DurableObject<ShardEnv> {
	/** テストから差し替えるためpublicにしている */
	clock: Clock = systemClock;
	policy: Policy = DEFAULT_POLICY;
	/** 失敗を知らせる先, 設定から届く(#30) */
	#failureBinding: string | null = null;
	retention: Retention = { doneMs: DEFAULT_SWEEP_AFTER_MS, failedMs: DEFAULT_FAILED_RETENTION_MS };

	#repo: JobRepo | undefined;
	#bucket: Bucket = { tokens: Number.POSITIVE_INFINITY, refilledAt: 0 };
	#bucketLoaded = false;
	// falseならkey_bucketは空, perKeyRate無効時の存在確認
	#keyBucketsMaybePresent = true;
	#policyLoaded = false;
	/** 直近tickで投入が止まった制約, 診断で外部へ公開(#10) */
	#lastBlocked: BlockedBy = { paused: false, capacity: false, tokens: false, perKey: false, perKeyTokens: false };
	#blockedLoaded = false;

	get repo(): JobRepo {
		if (!this.#repo) this.#repo = new JobRepo(this.ctx.storage);
		return this.#repo;
	}

	/** 自分が何番のshardかは名前から読む,ルーティングの判断はworker側が持つ */
	get shardIndex(): number {
		const name = this.ctx.id.name;
		if (!name) return 0;
		const at = name.lastIndexOf('#');
		if (at < 0) return 0;
		const parsed = Number(name.slice(at + 1));
		return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
	}

	/** ポリシーはSQLiteに配置, tickの同期読み取り用 */
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
		// configure()は実行時の意思, 静的設定より優先する印を付与(#6)
		this.#applySettings(settings, true);
	}

	/**
	 * 実行時の流量変更(#27)
	 * 渡した項目だけを今の設定へ重ね、残りは不変
	 * 変更は静的設定より優先, configure()と同じくpinを設定(#6)
	 */
	async updatePolicy(patch: Partial<Policy>): Promise<Policy> {
		this.#loadPolicy();
		const settings = this.#currentSettings();
		this.#applySettings({ ...settings, policy: { ...settings.policy, ...patch } }, true);
		// 停止した場合も予定は再設定, 回収の予定まで消すと実行中のジョブが未回収のまま残存
		await this.#armAlarm(this.clock.now());
		return this.policy;
	}

	/**
	 * 実行時の設定を破棄して静的設定へ復帰(#27)
	 * pinの解除のみで既定への上書きはなし, 次の投入に同梱された設定がそのまま有効(#6)
	 */
	async resetPolicy(): Promise<void> {
		this.repo.deleteSetting('settings_pinned');
		this.repo.deleteSetting('settings');
		this.policy = DEFAULT_POLICY;
		this.retention = { doneMs: DEFAULT_SWEEP_AFTER_MS, failedMs: DEFAULT_FAILED_RETENTION_MS };
		this.#policyLoaded = true;
		await this.#armAlarm(this.clock.now());
	}

	/** 今の設定, 保存が無ければ既定から構築 */
	#currentSettings(): ShardSettings {
		const raw = this.repo.readSetting('settings');
		return raw ? (JSON.parse(raw) as ShardSettings) : { policy: this.policy };
	}

	/**
	 * 運用診断(#10)
	 * activeは稼働中ジョブのバックログの深さ, outboxは投影の滞留, blockedは直近tickで投入が止まった制約
	 * 緩和対象の外部からの判断用(ADR-0009)
	 */
	async diagnostics(): Promise<{ active: number; outbox: number; blocked: BlockedBy; policy: Policy }> {
		this.#loadPolicy();
		this.#loadBlocked();
		// 現在適用中の値を返す, 画面は変更の前後をこれで確認(#27)
		return { active: this.repo.countActive(), outbox: this.repo.countOutbox(), blocked: this.#lastBlocked, policy: this.policy };
	}

	/** scheduleのskip判定のための読み取り, 削除済みはnull(ADR-0040) */
	async stateOf(jobId: string): Promise<string | null> {
		return this.repo.find(jobId)?.state ?? null;
	}

	/**
	 * 永続化した直近blockedを一度だけ読み戻す,無ければfalse既定のまま(#10)
	 * 軸を追加した後の起動では古い記録に新しい軸が無く、既定へ重ねてから使用(#27)
	 */
	#loadBlocked(): void {
		if (this.#blockedLoaded) return;
		const raw = this.repo.readSetting('last_blocked');
		if (raw) this.#lastBlocked = { ...this.#lastBlocked, ...(JSON.parse(raw) as Partial<BlockedBy>) };
		this.#blockedLoaded = true;
	}

	// メモリだけで持つとDOの退避で上限へ戻り、設定した流量を超えた投入が発生
	#loadBucket(): void {
		if (this.#bucketLoaded) return;
		const raw = this.repo.readSetting(BUCKET_KEY);
		if (raw) {
			const stored = JSON.parse(raw) as Bucket;
			if (Number.isFinite(stored.tokens) && Number.isFinite(stored.refilledAt)) this.#bucket = stored;
		}
		this.#bucketLoaded = true;
	}

	// tokensが上限の状態は保存対象外, 読み戻し時のrefillで同値になり毎tickの書き込みだけが増加
	#persistBucket(bucket: Bucket): void {
		const rate = this.policy.rate;
		if (rate === null || bucket.tokens >= rate.tokens) return;
		this.repo.writeSetting(BUCKET_KEY, JSON.stringify(bucket));
	}

	/**
	 * キー別バケットの反映(ADR-0045), 保存は使用中の行のみ
	 * 読んだが出力に無いキー(上限到達)が削除対象
	 * sweepは選考に入らないまま残った行の削除, tokensが0以上の行はintervalMs以内に上限へ回復
	 */
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

	/** blockedの保存, 変化した時だけ書いて毎tickの書き込みを回避(#10) */
	#persistBlocked(blocked: BlockedBy): void {
		this.#loadBlocked();
		const encoded = JSON.stringify(blocked);
		if (JSON.stringify(this.#lastBlocked) === encoded) return;
		this.#lastBlocked = blocked;
		this.repo.writeSetting('last_blocked', encoded);
	}

	/**
	 * 設定の反映, 内容が同じなら書き込みなし(enqueueごとの書き込み増加の回避)
	 * pinnedはconfigure()由来か, enqueue同梱の静的設定か
	 * 一度configure()されたら以降の静的設定は無視, 実行時に制限した流量の次の投入での復元を防止(#6)
	 * 静的設定へ戻すには再度configure()が必要
	 */
	#applySettings(settings: ShardSettings, pinned: boolean): void {
		this.#loadPolicy();
		// 宛先はpolicyのpinと分離, 流量を固定したshardにも後から追加した宛先が届く(#30)
		// 省略された場合は今の宛先を維持, 投入の経路ごとに宛先の有無が別
		if (settings.failureBinding !== undefined) this.#writeFailureBinding(settings.failureBinding);
		if (!pinned && this.repo.readSetting('settings_pinned') === '1') return;
		const { failureBinding: _ignored, ...rest } = settings;
		const encoded = JSON.stringify(rest);
		this.policy = { ...DEFAULT_POLICY, ...rest.policy };
		this.retention = retentionOf(rest);
		if (pinned && this.repo.readSetting('settings_pinned') !== '1') this.repo.writeSetting('settings_pinned', '1');
		if (this.repo.readSetting('settings') === encoded) return;
		this.repo.writeSetting('settings', encoded);
	}

	/** 宛先はpolicyと寿命が別で別のキーに配置(#30) */
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

	/**
	 * まとめて投入
	 * 個別RPCの逐次enqueueはDOの1,000 req/sソフト上限に律速され実測78件/秒が上限
	 * 上限を回避する唯一の手段で、単発のenqueueもこれを使用
	 */
	async enqueueMany(inputs: readonly EnqueueInput[], settings?: ShardSettings): Promise<string[]> {
		const now = this.clock.now();
		this.#loadPolicy();
		// enqueue同梱は静的設定, configure()でpin済みなら無視(#6)
		if (settings) this.#applySettings(settings, false);
		const ids: string[] = [];

		for (const input of inputs) {
			const id = input.id ?? formatJobId({ binding: input.binding, shard: this.shardIndex, localId: createId() });

			// IDを指定した再投入は既存のIDを回答, Run DOの再送での同一ノードのジョブ増加を防止
			if (input.id !== undefined && this.repo.find(id)) {
				ids.push(id);
				continue;
			}

			if (input.uniqueKey !== undefined) {
				const expiresAt = now + (input.uniqueForMs ?? DEFAULTS.uniqueForMs);
				const existing = this.repo.reserveUniqueKey(input.uniqueKey, id, expiresAt, now);
				// 衝突は正常系として扱い先行するジョブIDを返却, enqueueは冪等(ADR-0021)
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
				createdAt: now,
				payload: input.payload,
				runId: input.runId ?? null,
				nodeId: input.nodeId ?? null,
			});
			ids.push(id);
		}

		await this.#armAlarm(now);
		return ids;
	}

	/**
	 * consumerからの完了報告
	 * 失敗ならバックオフを計算してSCHEDULEDへ, 試行回数を使い切っていればFAILED
	 * リトライ方針はここが持ち、Queuesの`max_retries`は非適用(ADR-0004)
	 */
	async report(jobId: string, outcome: { ok: boolean; error?: string; result?: unknown; spawns?: readonly SpawnRequest[] }): Promise<void> {
		const now = this.clock.now();
		const row = this.repo.find(jobId);
		// 報告を受け付けられる状態かをここで判定
		// compareAndSetでの判定は記録が遷移の後になり、アウトボックスに履歴が含まれない(ADR-0028)
		if (!row || (row.state !== 'QUEUED' && row.state !== 'RUNNING')) return;

		const serialized = outcome.ok ? serializeResult(outcome.result) : null;
		// runのノードでは戻り値が後段のpayloadの材料, 保存できないまま成功にすると警告なくnullが下流へ渡る(ADR-0035)
		if (outcome.ok && row.run_id !== null && outcome.result !== undefined && serialized === null) {
			await this.report(jobId, { ok: false, error: `cannot store the result (over ${RESULT_MAX_CHARS} chars or not serializable)` });
			return;
		}

		const attempts = row.attempts + 1;
		// 1回目で成功したジョブの履歴はジョブ行から導出可能で記録は省略
		// 導出できないのは失敗の理由と試行ごとの時刻だけ, 常時書くと1ジョブあたりの書き込みが1回増える
		const worthRecording = !outcome.ok || attempts > 1;
		// 遷移で消えるdispatched_atの開始時刻を先に確保
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
			// 1回実行して成功したならattemptsは1,失敗時だけ数えると完了ジョブが0回に見える
			// 結果は同じ遷移のsetに同梱, 別UPDATEでは書き込みが1増加(#9)
			this.repo.compareAndSet(jobId, ['QUEUED', 'RUNNING'], 'COMPLETED', {
				now,
				countAttempt: true,
				result: serialized,
				// 失敗した試行のspawnは非送信, 再実行で再度要求が届く(ADR-0032)
				...(outcome.spawns ? { spawns: outcome.spawns } : {}),
			});
			await this.#armAlarm(now);
			return;
		}

		const next = nextAttempt({
			attempts,
			maxAttempts: row.max_attempts,
			backoff: JSON.parse(row.backoff) as Backoff,
			now,
			// 乱数はここで作成してcoreへ渡す, coreは純粋に維持(ADR-0018)
			rand: Math.random(),
		});

		if (next.kind === 'exhausted') {
			// 理由はRun DOへ送信, ノード表示から参照不能だと失敗の原因がジョブ側にのみ残存(ADR-0031)
			this.repo.compareAndSet(jobId, ['QUEUED', 'RUNNING'], 'FAILED', { now, attempts, error: outcome.error ?? null });
			await this.#armAlarm(now);
			return;
		}

		this.repo.compareAndSet(jobId, ['QUEUED', 'RUNNING'], 'SCHEDULED', {
			now,
			attempts,
			runAfter: next.runAfter,
			dispatchedAt: null,
		});
		await this.#armAlarm(next.runAfter);
	}

	/**
	 * 実行中のperformerからの生存報告
	 *
	 * reaperの無応答判定の起点をここへ移動, 所要時間が入力で変わるジョブでのtimeoutMsの最長化が不要
	 * 進捗の画面表示用に投影にも追加, 報告の間隔はconsumer側で制限
	 */
	async heartbeat(jobId: string, progress?: number): Promise<boolean> {
		const now = this.clock.now();
		// 範囲外は破棄, 保存すると画面の進捗が100%を超過
		const clamped = typeof progress === 'number' && Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : null;
		if (!this.repo.heartbeat(jobId, now, clamped)) return false;
		// 投影のためのalarm設定, 次のreaper期限まで投影が無いと進捗が数分遅延
		await this.#armAlarm(now);
		return true;
	}

	/**
	 * at-most-onceのジョブの実行権
	 * Queues自体がat-least-onceで重複配送があり、単一SQLのrowsWritten判定で実行権を1つに限定(ADR-0007)
	 */
	async claim(jobId: string): Promise<boolean> {
		return this.repo.compareAndSet(jobId, ['QUEUED'], 'RUNNING', { now: this.clock.now() });
	}

	/**
	 * ダッシュボードからの手動リトライ
	 * FAILEDとSTALLEDは終端だが不可逆ではない(ADR-0012)
	 */
	async retry(jobId: string): Promise<MutationResult> {
		const now = this.clock.now();
		const ok = this.repo.compareAndSet(jobId, ['FAILED', 'STALLED'], 'SCHEDULED', {
			now,
			runAfter: now,
			dispatchedAt: null,
		});
		if (ok) {
			await this.#armAlarm(now);
			return { ok: true };
		}
		// 理由を分けて返す, 保持期間経過で消えたのか状態違いかで利用者の対応が変わる(ADR-0027)
		return { ok: false, reason: this.repo.find(jobId) ? 'invalid-state' : 'gone' };
	}

	/**
	 * 予約済みジョブの実行時刻と優先度の変更
	 *
	 * 対象はSCHEDULEDのみ, QUEUED以降は投入済みで予定を変えても実行は止まらない
	 * 取り消しと再投入はジョブIDが変わりuniqueKeyの予約も解放, 同じ行の更新で回避
	 */
	async reschedule(jobId: string, patch: { runAfter: number; priority?: number }): Promise<MutationResult> {
		const now = this.clock.now();
		const ok = this.repo.reschedule(jobId, patch.runAfter, patch.priority, now);
		if (ok) {
			// 前倒しと後ろ倒しの両方に対応, alarm再設定なしでは早めた予定で発火が無い
			await this.#armAlarm(Math.min(patch.runAfter, now));
			return { ok: true };
		}
		return { ok: false, reason: this.repo.find(jobId) ? 'invalid-state' : 'gone' };
	}

	/**
	 * 実行前のジョブの取り消し
	 * QUEUED以降はconsumerが実行を開始した可能性があり、未取り消しでの成功返却を回避(ADR-0012)
	 */
	async cancel(jobId: string): Promise<MutationResult> {
		const now = this.clock.now();
		const ok = this.repo.compareAndSet(jobId, ['SCHEDULED'], 'CANCELLED', { now });
		// 投影のためのtick起動, alarmなしでは動きが無いシャードの読み取りモデルが取り消し前のまま残存
		if (ok) {
			await this.#armAlarm(now);
			return { ok: true };
		}
		return { ok: false, reason: this.repo.find(jobId) ? 'invalid-state' : 'gone' };
	}

	/**
	 * 一括のリトライと取り消し
	 *
	 * 対象は数秒遅れる読み取りモデル由来で、状態の判定はここで再実施
	 * 1件ずつのRPCは200件で200往復、shard単位の1回に集約
	 * alarmは全件の処理後に1回だけ設定、件数ぶんの再設定でも予定は不変
	 */
	async mutateMany(action: 'retry' | 'cancel', jobIds: readonly string[]): Promise<BulkResult> {
		const now = this.clock.now();
		const ok: string[] = [];
		const failed: BulkFailure[] = [];

		for (const jobId of jobIds) {
			const applied =
				action === 'retry'
					? this.repo.compareAndSet(jobId, ['FAILED', 'STALLED'], 'SCHEDULED', { now, runAfter: now, dispatchedAt: null })
					: this.repo.compareAndSet(jobId, ['SCHEDULED'], 'CANCELLED', { now });
			if (applied) ok.push(jobId);
			else failed.push({ id: jobId, reason: this.repo.find(jobId) ? 'invalid-state' : 'gone' });
		}

		if (ok.length > 0) await this.#armAlarm(now);
		return { ok, failed };
	}

	async alarm(): Promise<void> {
		try {
			await this.#tick();
		} catch (error) {
			// alarm()がthrowするとworkerdは2秒起点の指数バックオフで最大6回のみリトライ
			// 捕捉して必ず次のalarmを再設定し、一時的な失敗での調停停止を防止
			console.error('tsumugi: tick failed', error);
			await this.ctx.storage.setAlarm(this.clock.now() + 5_000);
		}
	}

	async #tick(): Promise<void> {
		const now = this.clock.now();
		this.#loadPolicy();
		this.#loadBucket();
		const { jobs, readyCount } = this.repo.scheduleWindow(now, TICK_LIMIT);

		const readyKeys =
			this.policy.perKeyRate === null
				? []
				: [
						...new Set(
							jobs.flatMap((j) => (j.state === 'SCHEDULED' && j.runAfter <= now && j.concurrencyKey !== null ? [j.concurrencyKey] : [])),
						),
					];
		const keyBuckets = this.repo.readKeyBuckets(readyKeys);
		const output = schedule({ now, jobs, policy: this.policy, bucket: this.#bucket, keyBuckets });
		this.#bucket = output.bucket;
		this.#persistBucket(output.bucket);
		this.#persistKeyBuckets(keyBuckets, output.keyBuckets, now);
		// どの制約で投入が止まったかを診断で外部へ公開, DO退避後も保持(#10)
		this.#persistBlocked(output.blocked);

		const messages: MessageSendRequest<DispatchMessage>[] = [];
		for (const decision of output.decisions) {
			switch (decision.type) {
				case 'dispatch': {
					const row = this.repo.find(decision.id);
					if (!row) break;
					// 先に状態を進めてから投入, 投入に失敗してもQUEUEDのまま残りreaperが回収可能
					if (!this.repo.compareAndSet(decision.id, ['SCHEDULED'], 'QUEUED', { now, dispatchedAt: now })) break;
					messages.push({
						body: {
							jobId: row.id,
							binding: row.binding,
							attempt: row.attempts + 1,
							payload: this.repo.payloadOf(row),
							timeoutMs: row.timeout_ms,
							claimRequired: row.guarantee === 'at-most-once',
						},
					});
					break;
				}
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

		// 100件上限で分割して送信, concurrency>100だと1 tickの投入がこれを超過(ADR-0009)
		for (let i = 0; i < messages.length; i += SEND_BATCH_LIMIT) {
			await this.env.TSUMUGI_QUEUE.sendBatch(messages.slice(i, i + SEND_BATCH_LIMIT));
		}

		const projected = await this.#project();
		const notified = await this.#notifyRuns();
		const notifiedFailures = await this.#notifyFailures();
		const { deleted, retryAt } = this.#sweep(now);

		// 上限まで読んだなら残りがある可能性が高く、即座に自分を再起動
		// 投入候補はreadyCountで判定, 実行中のジョブで範囲が埋まっても投入すべき候補が無ければ再実行なし
		// ただしトークン待ちでは読める候補が変わらず, readyCount起因の再実行は回復時刻のalarmで代替
		// 投影待ちの残りも確認, tickのawait中に入った報告やclaimは投影されないまま残る
		const blockedOnTokens = output.blocked.tokens || output.blocked.perKeyTokens;
		const hasMore =
			(readyCount >= TICK_LIMIT && !blockedOnTokens) ||
			projected >= PROJECTION_LIMIT ||
			deleted >= SWEEP_LIMIT ||
			notified >= NOTIFY_LIMIT ||
			notifiedFailures >= FAILURE_NOTIFY_LIMIT ||
			this.repo.countOutbox() > 0;
		const candidates = [hasMore ? now : output.nextAlarmAt, retryAt].filter((v): v is number => v !== null);
		const next = candidates.length > 0 ? Math.min(...candidates) : null;
		// tickの実行中に設定されたalarmを後ろへずらさない
		// alarmはハンドラの開始時に消え、ここに在るものは割り込んだ処理が要求した予定
		// setAlarmでの上書きは投影が保持期間の経過まで遅延
		if (next !== null) await this.#armAlarm(next);
	}

	/**
	 * アウトボックスをD1へ転送(ADR-0008)
	 * D1への書き込みの成功後に削除, 失敗時はカーソルが進まず次のtickで追いつく
	 */
	async #project(): Promise<number> {
		const rows = this.repo.outboxBatch(PROJECTION_LIMIT);
		if (rows.length === 0) return 0;
		await project(this.env.TSUMUGI_DB, rows);
		// 投影の成功後にカーソルを前進, 投影は冪等で再処理は無害(#7)
		this.repo.deleteOutboxThrough(rows[rows.length - 1]!.seq);
		// メトリクスはカーソルの後, 非冪等で冪等な投影とは再試行単位を分離(ADR-0016 / #7)
		// カーソルより後で同じ行の二重書き込みは無い, 反面この回の失敗ぶんは記録されずat-most-once
		// 省略可能な機能につき失敗は捕捉, ジョブ調停を含むtick全体は継続
		try {
			// 明細と同じ材料から時系列を書く, sweepで明細が消えてもこちらは残る(ADR-0016)
			writeMetrics(
				this.env.TSUMUGI_METRICS,
				rows.map((row) => JSON.parse(row.snapshot) as JobRow),
			);
		} catch (error) {
			console.error('tsumugi: writeMetrics failed', error);
		}
		return rows.length;
	}

	/**
	 * 未送信の通知をRun DOへ送信(ADR-0031)
	 *
	 * 宛先ごとにまとめて送り、送信の成功後に削除
	 * 失敗時はカーソルが進まず次のtickで再送, Run DO側は同じ通知を二度受けても結果が不変
	 */
	async #notifyRuns(): Promise<number> {
		const rows = this.repo.notifyBatch(NOTIFY_LIMIT);
		if (rows.length === 0) return 0;

		const namespace = this.env.RUN;
		if (!namespace) {
			// flowsを使うのにbindingが無い設定漏れ, 削除せず残して設定後に配送(ADR-0013)
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

	/**
	 * 未送信の失敗を通知先のperformerへ投入(#30)
	 *
	 * 投入の成功後に削除, 失敗時はカーソルが進まず次のtickで再送
	 * 通知そのものの失敗は通知の対象外, 自分を呼び続ける循環の防止
	 */
	async #notifyFailures(): Promise<number> {
		const rows = this.repo.failureBatch(FAILURE_NOTIFY_LIMIT);
		if (rows.length === 0) return 0;

		const target = this.#failureBinding;
		if (target === null) {
			// 宛先が無い間に記録されたぶんは破棄, 残すと設定後に古い失敗がまとめて届く
			this.repo.deleteFailureThrough(rows[rows.length - 1]!.seq);
			return rows.length;
		}

		const notices = rows.map((row) => JSON.parse(row.payload) as FailureNotice);
		const inputs: EnqueueInput[] = notices
			// 通知そのものの失敗は通知の対象外, 自分を呼び続ける循環の防止(#30)
			.filter((notice) => notice.binding !== target)
			.map((notice) => ({
				binding: target,
				payload: notice,
				// 同じ失敗の二重投入は無し, 再送でも同じIDで既存が返る(ADR-0029)
				// 元のIDはそのまま使えず埋め込める形へ変換, ローカル部だけではbindingを跨いで衝突
				id: formatJobId({
					binding: target,
					shard: 0,
					localId: `failure-${embedJobId(notice.jobId)}-${notice.attempts}`,
				}),
			}));

		if (inputs.length > 0) {
			// 通知先は分割しない前提でshard 0へ送信, 宛先を分けても順序も流量も不変
			const namespace = this.env.JOB_SHARD;
			if (!namespace) {
				// 自分自身のbindingが無い構成, 削除せず残して設定後に配送(ADR-0013)
				console.error('tsumugi: cannot notify the failure, JOB_SHARD binding is not configured');
				return 0;
			}
			await namespace.get(namespace.idFromName(shardName(target, 0))).enqueueMany(inputs);
		}
		this.repo.deleteFailureThrough(rows[rows.length - 1]!.seq);
		return rows.length;
	}

	/**
	 * 不要になった行の削除
	 * 対象は投影済みの終端ジョブと期限切れの重複排除キー
	 */
	#sweep(now: number): { deleted: number; retryAt: number | null } {
		// 対象の有無を先に読む, 状態をメモリに持つとDOのエビクトで削除が停止
		const state = this.repo.sweepState(now, this.retention);
		if (state.uniqueKeys) this.repo.sweepExpiredUniqueKeys(now);
		const deleted = state.jobs ? this.repo.sweepTerminal(now, this.retention, SWEEP_LIMIT) : 0;

		// 次に対象が出る時刻まで待機
		// 稼働中が無くなるとalarmが設定されず、削除の機会が永久に無い
		// 一定間隔の起動は失敗ジョブだけが残る状態で無意味な書き込みが増加
		const next = deleted > 0 ? this.repo.sweepState(now, this.retention).nextDueAt : state.nextDueAt;
		return { deleted, retryAt: next === null ? null : Math.max(next, now + 1_000) };
	}

	/** 履歴はアウトボックス経由, 記録してから遷移するとD1へ同じ投影で届く */
	#recordAttempt(jobId: string, attempt: number, state: string, startedAt: number | null, finishedAt: number, error: string | null): void {
		this.repo.recordAttempt({ job_id: jobId, attempt, state, started_at: startedAt, finished_at: finishedAt, error });
	}

	/** 予定より早い時刻のalarmがある場合は上書きなし */
	async #armAlarm(at: number): Promise<void> {
		const current = await this.ctx.storage.getAlarm();
		if (current === null || current > at) await this.ctx.storage.setAlarm(at);
	}
}
