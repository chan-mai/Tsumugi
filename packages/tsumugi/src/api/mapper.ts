import type { Attempt, Job, JobListItem, JobSortKey } from '../core/entity/job.entity.js';
import type { Run, RunListItem, RunNode } from '../core/entity/run.entity.js';
import type { Retryable } from '../service/types.js';
import type { SortColumn } from './sort.js';
import type { AttemptRecord, JobDetail, JobSummary, RunDetail, RunNode as RunNodeResponse, RunSummary } from './types.js';

export const SORT_KEYS = {
	updated_at: 'updatedAt',
	created_at: 'createdAt',
	binding: 'binding',
	state: 'state',
	priority: 'priority',
	attempts: 'attempts',
} as const satisfies Record<SortColumn, JobSortKey>;

const toAttemptRecord = (attempt: Attempt): AttemptRecord => ({
	attempt: attempt.attempt,
	state: attempt.state,
	started_at: attempt.startedAt,
	finished_at: attempt.finishedAt,
	error: attempt.error,
});

export const toJobSummary = (job: Retryable<JobListItem>): JobSummary => ({
	id: job.id,
	binding: job.binding,
	state: job.state,
	priority: job.priority,
	attempts: job.attempts,
	max_attempts: job.maxAttempts,
	created_at: job.createdAt,
	updated_at: job.updatedAt,
	dispatched_at: job.dispatchedAt,
	retryable: job.retryable,
});

// 履歴は詳細のみ, 一覧では1画面数百KBの可能性(ADR-0028)
// `attempts`は試行回数で別名使用, 上書きで画面のn/m表示が破損
export const toJobDetail = (job: Retryable<Job>): JobDetail => ({
	...toJobSummary(job),
	concurrency_key: job.concurrencyKey,
	unique_key: job.uniqueKey,
	guarantee: job.guarantee,
	run_after: job.runAfter,
	expires_at: job.expiresAt,
	cancel_requested_at: job.cancelRequestedAt,
	progress: job.progress,
	traceparent: job.traceparent,
	logs: job.logs,
	payload: job.payload,
	// payload同様JSON文字列のまま返却
	result: job.result,
	run_id: job.runId,
	node_id: job.nodeId,
	attempts_log: job.attemptsLog.map(toAttemptRecord),
});

export const toRunSummary = (run: RunListItem): RunSummary => ({
	id: run.id,
	flow: run.flow,
	state: run.state,
	node_total: run.nodeTotal,
	node_done: run.nodeDone,
	node_failed: run.nodeFailed,
	created_at: run.createdAt,
	updated_at: run.updatedAt,
});

export const toRunDetail = (run: Retryable<Run>): RunDetail => ({
	...toRunSummary(run),
	input: run.input,
	parent_run_id: run.parentRunId,
	parent_node_id: run.parentNodeId,
	retryable: run.retryable,
});

// エラー本文はジョブ詳細のみ, 全ノード分で応答肥大
export const toRunNode = (node: RunNode): RunNodeResponse => ({
	id: node.id,
	binding: node.binding,
	state: node.state,
	container: node.container,
	parent: node.parent,
	origin: node.origin,
	after: node.after,
	job_id: node.jobId,
	child_run_id: node.childRunId,
	result: node.result,
	error: node.error,
	position: node.position,
	created_at: node.createdAt,
	updated_at: node.updatedAt,
	queued_at: node.queuedAt,
	run_after: node.runAfter,
	started_at: node.startedAt,
	finished_at: node.finishedAt,
	attempts_log: node.attempts.map((attempt) => ({ ...toAttemptRecord(attempt), error: null })),
});
