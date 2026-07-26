import type { BlockedBy } from '../core/types.js';

/**
 * REST APIの要求と応答の型
 *
 * `api/rest.ts`の応答をこの型で縛り, ダッシュボードも同じ定義を読む
 * パッケージからは出さない, 外部の利用者向けの仕様は`api/openapi.ts`が持つ
 */

/** 一覧の1行, 詳細だけが返す列は持たない */
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
	/** 保持期間から出す近似, 最終的な可否はretryの応答が決める(ADR-0027) */
	retryable: boolean;
};

/** 試行1回ぶんの記録(ADR-0028) */
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
	/** SCHEDULEDが実行可能になる時刻, 投影前の古い行はnull */
	run_after: number | null;
	/** 実行中のジョブが報告した進捗, 0以上1以下で報告が無ければnull */
	progress: number | null;
	payload: string;
	/** performの戻り値, 成功時のみ入る(#9) */
	result: string | null;
	/** 新しい試行から順に入る */
	attempts_log: AttemptRecord[];
};

export type JobListResponse = { jobs: JobSummary[]; total: number };
export type JobDetailResponse = { job: JobDetail };

export type CreateJobRequest = {
	binding: string;
	payload: unknown;
	maxAttempts?: number;
	delayMs?: number;
	priority?: number;
	concurrencyKey?: string;
	uniqueKey?: string;
};

export type CreateJobResponse = { id: string };

export type StatsResponse = {
	byState: Record<string, number>;
	/** 最古のSCHEDULEDの経過時間, 対象が無ければnull(#10) */
	oldestScheduledMs: number | null;
};

export type BindingsResponse = { bindings: string[] };

/** binding単位の運用診断(#10) */
export type DiagnosticsEntry = { active: number; outbox: number; blocked: BlockedBy };
export type DiagnosticsResponse = { shard: number; bindings: Record<string, DiagnosticsEntry> };

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
	/** subflowとして起動された場合の親, それ以外はnull */
	parent_run_id: string | null;
	parent_node_id: string | null;
	/** 終端でなければ再開できない(ADR-0034) */
	retryable: boolean;
};

export type RunNodeView = {
	id: string;
	binding: string;
	state: string;
	/** fan-outノード, ジョブを実行せず子ノードのみを持つ */
	container: boolean;
	parent: string | null;
	origin: string;
	after: string[];
	job_id: string | null;
	/** subflowノードが起動した子のrunID */
	child_run_id: string | null;
	/** fan-outノードの集計値のみが入る(ADR-0035) */
	result: string | null;
	error: string | null;
	position: number;
	created_at: number;
	updated_at: number;
};

export type RunListResponse = { runs: RunSummary[]; total: number };
export type RunDetailResponse = { run: RunDetail; nodes: RunNodeView[] };
export type FlowsResponse = { flows: string[] };

export type StartRunRequest = { flow: string; input: unknown; id?: string };
export type StartRunResponse = { id: string };

/** retry / cancelの応答 */
export type MutationResponse = { ok: true };

/** 4xx / 5xxで返る本文 */
export type ErrorResponse = { error: string };

/** 一覧の並べ替え, 許可した列以外はサーバ側で既定へ落ちる */
export type ListOrder = 'asc' | 'desc';

export type ListJobsQuery = {
	state?: string;
	binding?: string;
	sort?: string;
	order?: ListOrder;
	limit?: number;
	offset?: number;
};

export type ListRunsQuery = {
	state?: string;
	flow?: string;
	limit?: number;
	offset?: number;
};
