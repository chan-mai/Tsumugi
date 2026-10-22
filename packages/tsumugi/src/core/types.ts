export type JobState = 'SCHEDULED' | 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'STALLED';

export type ActiveState = 'SCHEDULED' | 'QUEUED' | 'RUNNING';

/** 既定はat-least-once(ADR-0006) */
export type DeliveryGuarantee = 'at-least-once' | 'at-most-once';

export type Backoff =
	| { kind: 'fixed'; delayMs: number; jitter?: boolean }
	| { kind: 'exponential'; baseMs: number; factor: number; maxMs: number; jitter?: boolean };

export type JobView = {
	id: string;
	state: ActiveState;
	priority: number;
	attempts: number;
	maxAttempts: number;
	concurrencyKey: string | null;
	runAfter: number;
	/** 実行開始期限, 経過後は実行せず終了 */
	expiresAt: number | null;
	createdAt: number;
	/** QUEUEDへの遷移時刻, SCHEDULEDならnull */
	dispatchedAt: number | null;
	heartbeatAt: number | null;
	guarantee: DeliveryGuarantee;
	timeoutMs: number;
	cancelRequestedAt: number | null;
};

export type RateLimit = { tokens: number; intervalMs: number };

export type Policy = {
	/** 投入の一時停止(#27), 実行中の回収とエージングは継続 */
	paused: boolean;
	concurrency: number;
	/** concurrencyKeyがnullのジョブには非適用 */
	perKeyConcurrency: number;
	rate: RateLimit | null;
	/** 全キー一律, concurrencyKeyがnullのジョブには非適用 */
	perKeyRate: RateLimit | null;
	/** nullでエージング無効, 既定は有効(ADR-0020) */
	agingIntervalMs: number | null;
	/** timeoutMs経過後の回収猶予 */
	reaperGraceMs: number;
};

/** 失敗通知のpayload(#30), ジョブ明細は読み取りモデルから取得 */
export type FailureNotice = {
	jobId: string;
	binding: string;
	/** 再試行途中の失敗は対象外 */
	state: 'FAILED' | 'STALLED';
	attempts: number;
	maxAttempts: number;
	/** 最後の試行の理由, 記録が無ければnull */
	error: string | null;
	/** 投入元のrun, 単発で投入したジョブはnull */
	runId: string | null;
	nodeId: string | null;
	failedAt: number;
};

export type SettledState = 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'STALLED';

/** 投入ごとにDOへ送信, 宛先と対象は常に一体で更新(#96) */
export type SettledTarget = {
	binding: string;
	/** 通知する終端状態, 明示必須でCOMPLETEDの暗黙の大量通知を防止 */
	states: readonly SettledState[];
};

/** 終端通知のpayload(#96), ジョブ明細は読み取りモデルから取得 */
export type SettledNotice = {
	jobId: string;
	binding: string;
	state: SettledState;
	attempts: number;
	maxAttempts: number;
	/** 最後の試行の理由, 失敗の終端以外と記録なしはnull */
	error: string | null;
	/** performの戻り値, COMPLETED以外と保存上限超過はnull */
	result: unknown;
	/** 投入元のrun, 単発で投入したジョブはnull */
	runId: string | null;
	nodeId: string | null;
	settledAt: number;
};

export type Bucket = { tokens: number; refilledAt: number };

/** tokens上限のキーは除外 */
export type KeyBuckets = Record<string, Bucket>;

export type Decision =
	| { type: 'dispatch'; id: string }
	/** 期限切れでCANCELLEDへ, 無応答のQUEUED, RUNNINGも対象(ADR-0047) */
	| { type: 'expire'; id: string }
	/** 無応答のat-least-onceジョブの再投入, SCHEDULEDへ */
	| { type: 'reap'; id: string; attempts: number }
	/** 無応答のat-most-onceジョブ, 再投入せずSTALLEDへ */
	| { type: 'stall'; id: string }
	/** 無応答かつ試行回数の枯渇, FAILEDへ */
	| { type: 'fail'; id: string; reason: 'exhausted' }
	/** 取り消し要求済み(#95), 実行や再投入をせずCANCELLEDへ */
	| { type: 'cancel'; id: string };

export type DispatchInput = {
	now: number;
	jobs: readonly JobView[];
	policy: Policy;
	bucket: Bucket;
	/** 省略時は全キーtokens上限扱い */
	keyBuckets?: KeyBuckets;
};

export type BlockedBy = {
	paused: boolean;
	/** concurrency: 同時実行の上限に到達 */
	capacity: boolean;
	/** rate: トークン不足 */
	tokens: boolean;
	/** perKeyConcurrency: キー単位の上限で候補を除外 */
	perKey: boolean;
	/** perKeyRate: キーのトークン不足で候補を除外 */
	perKeyTokens: boolean;
};

export type DispatchOutput = {
	decisions: Decision[];
	bucket: Bucket;
	keyBuckets: KeyBuckets;
	nextAlarmAt: number | null;
	/** 外部での緩和対象判断用(#10) */
	blocked: BlockedBy;
};

export type Retention = {
	/** COMPLETED / CANCELLED */
	sweepAfterMs: number;
	/** FAILED / STALLED, 手動リトライを受け付ける期間 */
	failedRetentionMs: number;
};
