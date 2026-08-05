import "@typespec/http";

using Http;

namespace Tsumugi;

// components.schemasに載るモデル
// JobDetail等の合成はallOfではなくスプレッドで平坦にする, 従来の形を保つ

model Error {
	error: string;
}

model Mutation {
	ok: true;
}

model JobSummary {
	id: string;
	binding: string;
	state: "SCHEDULED" | "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | "STALLED";
	priority: integer;
	attempts: integer;
	max_attempts: integer;

	@doc("epoch milliseconds")
	created_at: integer;

	@doc("epoch milliseconds")
	updated_at: integer;

	@doc("When the job moved to QUEUED. Null while it has never been dispatched.")
	dispatched_at: integer | null;

	@doc("Approximation derived from the retention period. The retry response is the final answer.")
	retryable: boolean;
}

model AttemptRecord {
	@doc("1-based attempt number")
	attempt: integer;

	state: string;
	started_at: integer | null;
	finished_at: integer;
	error: string | null;
}

model JobDetail {
	...JobSummary;
	concurrency_key: string | null;
	unique_key: string | null;
	guarantee: "at-least-once" | "at-most-once";

	@doc("When a scheduled job becomes eligible to run.")
	run_after: integer | null;

	@doc("Progress reported by the performer while running. Null until it reports.")
	@minValue(0)
	@maxValue(1)
	progress: numeric | null;

	@doc("JSON-encoded string")
	payload: string;

	@doc("JSON-encoded return value of perform. Present only on success.")
	result: string | null;

	@doc("Newest attempt first")
	attempts_log: AttemptRecord[];
}

model CreateJobRequest {
	@doc("Name of a registered performer")
	binding: string;

	@doc("Any JSON value")
	payload: unknown;

	@minValue(1)
	maxAttempts?: integer;

	@minValue(0)
	delayMs?: integer;

	priority?: integer;
	concurrencyKey?: string;
	uniqueKey?: string;
}

model RunSummary {
	id: string;
	flow: string;
	state: "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
	node_total: integer;
	node_done: integer;
	node_failed: integer;

	@doc("epoch milliseconds")
	created_at: integer;

	@doc("epoch milliseconds")
	updated_at: integer;
}

model RunDetail {
	...RunSummary;

	@doc("JSON-encoded string")
	input: string;

	@doc("Set when this run was started by a subflow node.")
	parent_run_id: string | null;

	parent_node_id: string | null;

	@doc("Only failed runs can be resumed.")
	retryable: boolean;
}

model RunNode {
	id: string;
	binding: string;
	state: string;

	@doc("Fan-out node. Runs no job of its own and only holds child nodes.")
	container: boolean;

	parent: string | null;
	origin: "static" | "fanOut" | "spawn";

	@doc("Node ids this node depends on")
	after: string[];

	job_id: string | null;

	@doc("Set on subflow nodes, holding the run they started.")
	child_run_id: string | null;

	@doc("Set on fan-out nodes only, holding the child summary.")
	result: string | null;

	error: string | null;

	@doc("Display order")
	position: integer;

	created_at: integer;
	updated_at: integer;
}

@doc("Either ids, or the filter fields. When ids is present the filter fields are ignored.")
model BulkRequest {
	@doc("Job ids to process")
	@minItems(1)
	@maxItems(200)
	ids?: string[];

	@doc("Filter by performer binding name")
	binding?: string;

	@doc("Only a state the operation accepts")
	state?: string;

	@doc("Exact uniqueKey")
	unique_key?: string;

	@doc("Exact concurrencyKey")
	concurrency_key?: string;

	@doc("Lower bound of created_at, inclusive")
	created_from?: integer;

	@doc("Upper bound of created_at, inclusive")
	created_to?: integer;

	@doc("Jobs to process in one request")
	@minValue(1)
	@maxValue(200)
	limit?: integer = 200;
}

model BulkResult {
	@doc("Job ids the coordinator accepted")
	ok: string[];

	@doc("Jobs the coordinator refused, with the reason")
	failed: {
		id: string;

		@doc("invalid-state matches 409, gone matches 410, invalid-id is a malformed job id")
		reason: "invalid-state" | "gone" | "invalid-id";
	}[];

	@doc("Estimated matches left after the limit. Always 0 when ids was given.")
	remaining: integer;
}

@doc("Exactly one of runAt and delayMs is required.")
model RescheduleRequest {
	@doc("Absolute epoch milliseconds")
	runAt?: integer;

	@doc("Relative to the time of the request")
	@minValue(0)
	delayMs?: integer;

	@doc("Changed together with the schedule when present")
	priority?: integer;
}

model StartRunRequest {
	@doc("Name of a registered flow")
	flow: string;

	@doc("Any JSON value")
	input: unknown;

	@doc("Pins the run id. Starting twice with the same id returns the existing run.")
	id?: string;

	@doc("Deadline of the whole run in milliseconds. Overrides the deadline of the flow definition.")
	@minValue(1)
	deadlineMs?: integer;
}

model BindingMetrics {
	binding: string;

	@doc("Terminal jobs in the window")
	total: integer;

	@doc("Jobs that ended as FAILED or STALLED")
	failed: integer;

	@minValue(0)
	@maxValue(1)
	failureRate: numeric;

	avgDurationMs: numeric;
	maxDurationMs: numeric;
	p95DurationMs: numeric;
	avgAttempts: numeric;
}

model MetricsPoint {
	@doc("Start of the hour, epoch milliseconds")
	at: integer;

	total: integer;
	failed: integer;
	avgDurationMs: numeric;
}

model Diagnostics {
	@doc("Number of jobs in a non-terminal state")
	active: integer;

	@doc("Number of rows waiting to be projected")
	outbox: integer;

	@doc("Which limit stopped dispatching on the last tick")
	blocked: {
		@doc("Concurrency limit reached")
		capacity: boolean;

		@doc("Not enough rate tokens")
		tokens: boolean;

		@doc("Candidates skipped by the per-key concurrency limit")
		perKey: boolean;
	};
}

// 以降は応答の包み, componentsには載らない
// 説明は@docがそのままresponsesのdescriptionになる

@doc("Authentication failed")
model Unauthorized {
	@statusCode statusCode: 401;
	@body body: Error;
}

@doc("Not found")
model NotFound {
	@statusCode statusCode: 404;
	@body body: Error;
}

@doc("Database migrations are not applied, or D1 is temporarily unavailable")
model Unavailable {
	@statusCode statusCode: 503;
	@body body: Error;
}

@doc("Not available in this deployment")
model NotImplemented {
	@statusCode statusCode: 501;
	@body body: Error;
}

@doc("Accepted")
model MutationAccepted {
	@statusCode statusCode: 200;
	@body body: Mutation;
}

@doc("Not allowed in the current state")
model InvalidState {
	@statusCode statusCode: 409;
	@body body: Error;
}

@doc("Removed from the coordinator after the retention period")
model Gone {
	@statusCode statusCode: 410;
	@body body: Error;
}

@doc("Malformed job id")
model BadJobId {
	@statusCode statusCode: 400;
	@body body: Error;
}

@doc("Malformed run id")
model BadRunId {
	@statusCode statusCode: 400;
	@body body: Error;
}

@doc("Invalid request body")
model BadBody {
	@statusCode statusCode: 400;
	@body body: Error;
}

// 400は1つしか書けないので, 本文とジョブIDの両方で断る経路は説明をまとめる
@doc("Malformed job id, or invalid request body")
model BadJobIdOrBody {
	@statusCode statusCode: 400;
	@body body: Error;
}

alias MutationResponses = MutationAccepted | InvalidState | Gone;
