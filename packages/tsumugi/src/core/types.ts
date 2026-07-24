/** ADR-0012の状態機械 */
export type JobState = 'SCHEDULED' | 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'STALLED';

/** 稼働中の状態,スケジューラが扱う対象 */
export type ActiveState = 'SCHEDULED' | 'QUEUED' | 'RUNNING';

/** ADR-0006,既定はat-least-once */
export type DeliveryGuarantee = 'at-least-once' | 'at-most-once';

/** ADR-0020,ジッタ用の乱数は純粋性のため外から受け取る */
export type Backoff =
	| { kind: 'fixed'; delayMs: number; jitter?: boolean }
	| { kind: 'exponential'; baseMs: number; factor: number; maxMs: number; jitter?: boolean };

/** スケジューラが判断に使うジョブの射影,ペイロードは不要 */
export type JobView = {
	id: string;
	state: ActiveState;
	priority: number;
	attempts: number;
	maxAttempts: number;
	concurrencyKey: string | null;
	/** SCHEDULEDが実行可能になる時刻 */
	runAfter: number;
	createdAt: number;
	/** QUEUEDへの遷移時刻, SCHEDULEDならnull */
	dispatchedAt: number | null;
	guarantee: DeliveryGuarantee;
	/** 実行のタイムアウト, reaperの沈黙判定の基準 */
	timeoutMs: number;
};

export type RateLimit = { tokens: number; intervalMs: number };

/** ADR-0009の3軸+ ADR-0020のエージング */
export type Policy = {
	concurrency: number;
	/** concurrencyKey単位の同時実行上限,キーがnullのジョブには非適用 */
	perKeyConcurrency: number;
	rate: RateLimit | null;
	/** nullでエージング無効, ADR-0020の既定は有効 */
	agingIntervalMs: number | null;
	/** timeoutMs経過後さらにこの時間沈黙したら回収 */
	reaperGraceMs: number;
};

export type Bucket = { tokens: number; refilledAt: number };

export type Decision =
	| { type: 'dispatch'; id: string }
	/** 沈黙したat-least-onceジョブの再投入, SCHEDULEDへ戻す */
	| { type: 'reap'; id: string; attempts: number }
	/** 沈黙したat-most-onceジョブ,再投入せずSTALLEDへ */
	| { type: 'stall'; id: string }
	/** 沈黙かつ試行回数の枯渇, FAILEDへ */
	| { type: 'fail'; id: string; reason: 'exhausted' };

export type ScheduleInput = {
	now: number;
	/** SCHEDULED/QUEUED/RUNNINGのみ,終端状態は渡さない */
	jobs: readonly JobView[];
	policy: Policy;
	bucket: Bucket;
};

/** 投入が止まった制約, ADR-0009の3軸のどれで詰まったか(#10) */
export type BlockedBy = {
	/** concurrency: 同時実行の枠が尽きた */
	capacity: boolean;
	/** rate: トークンが足りない */
	tokens: boolean;
	/** perKeyConcurrency: キー単位の上限で候補を飛ばした */
	perKey: boolean;
};

export type ScheduleOutput = {
	decisions: Decision[];
	bucket: Bucket;
	/** 次にスケジューラを起こす時刻,不要ならnull */
	nextAlarmAt: number | null;
	/** どの制約で投入が止まったか, どれを緩めればよいか外から判断できるようにする(#10) */
	blocked: BlockedBy;
};

/**
 * DOに終端ジョブを残す時間(ADR-0027)
 * 済んだジョブと再開余地のあるジョブは役割が違うので別の数字で持つ
 */
export type Retention = {
	/** COMPLETED / CANCELLED */
	doneMs: number;
	/** FAILED / STALLED, 手動リトライの窓 */
	failedMs: number;
};
