import type { BlockedBy, Policy } from '../core/types.js';
import type { JobLogEntry } from '../core/log.js';
import type { CreateJobInput, StartRunInput } from '../service/types.js';

export type { JobLogEntry };

// パッケージ非公開, 外部利用者向け仕様は`api/openapi.ts`

export type JobSummary = {
	id: string;
	binding: string;
	state: string;
	priority: number;
	attempts: number;
	max_attempts: number;
	created_at: number;
	updated_at: number;
	dispatched_at: number | null;
	/** 保持期間からの近似, 最終可否はretry応答で確定(ADR-0027) */
	retryable: boolean;
};

export type AttemptRecord = {
	attempt: number;
	state: string;
	started_at: number | null;
	finished_at: number;
	error: string | null;
};

export type JobDetail = JobSummary & {
	concurrency_key: string | null;
	unique_key: string | null;
	guarantee: string;
	/** SCHEDULEDの実行可能時刻, 投影前の古い行はnull */
	run_after: number | null;
	/** 実行開始期限, 経過後は未実行でCANCELLED, 無期限はnull */
	expires_at: number | null;
	cancel_requested_at: number | null;
	/** 0以上1以下 */
	progress: number | null;
	traceparent: string | null;
	logs: JobLogEntry[];
	payload: string;
	/** performの戻り値, 成功時のみ(#9) */
	result: string | null;
	run_id: string | null;
	/** run_idと対で設定 */
	node_id: string | null;
	/** 新しい試行順 */
	attempts_log: AttemptRecord[];
};

export type JobListResponse = { jobs: JobSummary[]; total: number };
export type JobDetailResponse = { job: JobDetail };

export type CreateJobRequest = CreateJobInput;

export type CreateJobResponse = { id: string };

export type StatsResponse = {
	byState: Record<string, number>;
	oldestScheduledMs: number | null;
};

export type BindingsResponse = { bindings: string[] };

type DiagnosticsEntry = { active: number; outbox: number; blocked: BlockedBy; policy: Policy };
export type DiagnosticsResponse = { shard: number; bindings: Record<string, DiagnosticsEntry> };

/** 指定項目のみ現設定へ上書き */
export type UpdatePolicyRequest = Partial<Policy>;
export type UpdatePolicyResponse = { binding: string; shards: number; policy: Policy };

/** 一部shardのみ反映時の応答(#27), 同一要求の再送で残りへ反映(冪等) */
export type PartialPolicyResponse = { error: string; binding: string; shards: number; failed: number[] };

export type RunSummary = {
	id: string;
	flow: string;
	state: string;
	node_total: number;
	node_done: number;
	node_failed: number;
	created_at: number;
	updated_at: number;
};

export type RunDetail = RunSummary & {
	input: string;
	/** subflow起動時の親, 他はnull */
	parent_run_id: string | null;
	parent_node_id: string | null;
	/** 終端のみ再開可能(ADR-0034) */
	retryable: boolean;
};

export type RunNode = {
	id: string;
	binding: string;
	state: string;
	/** fan-outノード, ジョブ実行なしで子ノードのみ保持 */
	container: boolean;
	parent: string | null;
	origin: string;
	after: string[];
	job_id: string | null;
	child_run_id: string | null;
	/** fan-outノードの集計値のみ(ADR-0035) */
	result: string | null;
	error: string | null;
	position: number;
	created_at: number;
	updated_at: number;
	/** ジョブ行またはsubflowの子runの値, どちらも無ければnull */
	queued_at: number | null;
	run_after: number | null;
	started_at: number | null;
	/** 終端のみ */
	finished_at: number | null;
	/** errorは常にnull, 本文はジョブ詳細 */
	attempts_log: AttemptRecord[];
};

export type RunListResponse = { runs: RunSummary[]; total: number };
export type RunDetailResponse = { run: RunDetail; nodes: RunNode[] };
export type FlowsResponse = { flows: string[] };

export type StartRunRequest = StartRunInput;
export type StartRunResponse = { id: string };

export type Schedule = {
	name: string;
	kind: 'job' | 'flow';
	target: string;
	every_ms: number | null;
	cron: string | null;
	time_zone: string;
	overlap: 'skip' | 'overlap';
	paused: boolean;
	next_occurrence_at: number;
	/** 直近発火の予定時刻, last_fired_atとの差が遅延 */
	last_occurrence_at: number | null;
	last_fired_at: number | null;
	last_job_id: string | null;
	last_run_id: string | null;
	last_skipped_at: number | null;
	skipped_count: number;
	last_error: string | null;
};

export type SchedulesResponse = { schedules: Schedule[] };

export type TriggerScheduleResponse = { id: string; kind: 'job' | 'flow' };

/** requestedは協調的な取り消し要求の受理(ADR-0052) */
export type MutationResponse = { ok: true; requested?: true };

export type ErrorResponse = { error: string };

type BindingMetricsView = {
	binding: string;
	total: number;
	failed: number;
	/** 0以上1以下 */
	failureRate: number;
	avgDurationMs: number;
	maxDurationMs: number;
	p95DurationMs: number;
	avgAttempts: number;
};

/** 1時間ごとの推移 */
type MetricsPointView = {
	/** 区間の開始時刻, epochミリ秒 */
	at: number;
	total: number;
	failed: number;
	avgDurationMs: number;
};

export type MetricsResponse = { hours: number; bindings: BindingMetricsView[]; series: MetricsPointView[] };
