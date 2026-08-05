import "@typespec/http";
import "@typespec/openapi";
import "./models.tsp";

using Http;
using OpenAPI;

namespace Tsumugi;

// 経路の網羅は`createRest`が登録したものと単体テストで突き合わせる, 片方だけ増えると生成物が実装とずれる
// operationIdは生成器の既定名に任せず明示する

@route("/api/jobs")
@operationId("listJobs")
@summary("List jobs")
@doc("Reads the D1 read model, which lags behind the coordinator by a few seconds. Filters combine with AND. Key filters match exactly; prefix and substring matching are not supported.")
@returnsDoc("A page of jobs")
@get
op listJobs(
	@query @doc("Filter by job state") state?: string,
	@query @doc("Filter by performer binding name") binding?: string,
	@query @doc("Exact job id") id?: string,
	@query @doc("Exact uniqueKey") unique_key?: string,
	@query @doc("Exact concurrencyKey") concurrency_key?: string,
	@query @doc("Lower bound of created_at, inclusive") created_from?: integer,
	@query @doc("Upper bound of created_at, inclusive") created_to?: integer,

	@query
	@doc("Unknown values fall back to the default instead of failing.")
	sort?: "updated_at" | "created_at" | "binding" | "state" | "priority" | "attempts" = "updated_at",

	@query order?: "asc" | "desc" = "desc",
	@query @maxValue(100) limit?: integer = 20,
	@query offset?: integer = 0,
): {
	@statusCode statusCode: 200;

	@body body: {
		jobs: JobSummary[];
		total: integer;
	};
} | Unauthorized | Unavailable;

@route("/api/jobs")
@operationId("createJob")
@summary("Enqueue a job")
@returnsDoc("Enqueued. On a uniqueKey collision the id of the existing job is returned.")
@post
op createJob(@body body: CreateJobRequest): {
	@statusCode statusCode: 201;

	@body body: {
		id: string;
	};
} | BadBody | Unauthorized | NotImplemented | Unavailable;

@route("/api/jobs/{id}")
@operationId("getJob")
@summary("Get a job with its attempt log")
@returnsDoc("The job")
@get
op getJob(@path @doc("Job id") id: string): {
	@statusCode statusCode: 200;

	@body body: {
		job: JobDetail;
	};
} | Unauthorized | NotFound | Unavailable;

@route("/api/jobs/{id}/retry")
@operationId("retryJob")
@summary("Retry a failed job")
@doc("Accepted for FAILED and STALLED jobs only.")
@post
op retryJob(@path @doc("Job id") id: string): MutationResponses | BadJobId | Unauthorized | Unavailable;

@route("/api/jobs/{id}/reschedule")
@operationId("rescheduleJob")
@summary("Change when a scheduled job runs")
@doc("Accepted for SCHEDULED jobs only. The job id and any uniqueKey reservation are kept.")
@post
op rescheduleJob(
	@path @doc("Job id") id: string,
	@body body: RescheduleRequest,
): MutationResponses | BadJobIdOrBody | Unauthorized | Unavailable;

@route("/api/jobs/{id}/cancel")
@operationId("cancelJob")
@summary("Cancel a job that has not started")
@doc("Accepted for SCHEDULED jobs only. From QUEUED onwards execution may already have begun.")
@post
op cancelJob(@path @doc("Job id") id: string): MutationResponses | BadJobId | Unauthorized | Unavailable;

@route("/api/jobs/bulk-retry")
@operationId("bulkRetryJobs")
@summary("Retry several failed jobs")
@doc("Accepts FAILED and STALLED jobs. Jobs in any other state are reported in failed.")
@returnsDoc("Processed, including partial refusals")
@post
op bulkRetryJobs(@body body: BulkRequest): {
	@statusCode statusCode: 200;
	@body body: BulkResult;
} | BadBody | Unauthorized | Unavailable;

@route("/api/jobs/bulk-cancel")
@operationId("bulkCancelJobs")
@summary("Cancel several jobs that have not started")
@doc("Accepts SCHEDULED jobs. Jobs in any other state are reported in failed.")
@returnsDoc("Processed, including partial refusals")
@post
op bulkCancelJobs(@body body: BulkRequest): {
	@statusCode statusCode: 200;
	@body body: BulkResult;
} | BadBody | Unauthorized | Unavailable;

@route("/api/bindings")
@operationId("listBindings")
@summary("List registered performer bindings")
@returnsDoc("Binding names")
@get
op listBindings(): {
	@statusCode statusCode: 200;

	@body body: {
		bindings: string[];
	};
} | Unauthorized | Unavailable;

@route("/api/metrics")
@operationId("getMetrics")
@summary("Failure rate and duration from Analytics Engine")
@doc("Reads the time series written for terminal jobs. Available only when the deployment configures an account API token. Counts are weighted by the sample interval, so they stay comparable when sampling kicks in.")
@returnsDoc("Aggregates per binding and per hour")
@get
op getMetrics(
	@query @doc("How far back to aggregate") @minValue(1) @maxValue(720) hours?: integer = 24,
	@query @doc("Filter by performer binding name") binding?: string,
): {
	@statusCode statusCode: 200;

	@body body: {
		hours: integer;
		bindings: BindingMetrics[];
		series: MetricsPoint[];
	};
} | BadMetricsQuery | Unauthorized | NotImplemented | AnalyticsRefused | Unavailable;

@route("/api/stats")
@operationId("getStats")
@summary("Job counts per state")
@returnsDoc("Aggregates")
@get
op getStats(): {
	@statusCode statusCode: 200;

	@body body: {
		byState: Record<integer>;

		@doc("Age of the oldest scheduled job")
		oldestScheduledMs: integer | null;
	};
} | Unauthorized | Unavailable;

@route("/api/diagnostics")
@operationId("getDiagnostics")
@summary("Operational diagnostics per binding")
@doc("Asks the coordinator directly rather than the read model, so the numbers are current.")
@returnsDoc("Diagnostics")
@get
op getDiagnostics(): {
	@statusCode statusCode: 200;

	@body body: {
		shard: integer;
		bindings: Record<Diagnostics>;
	};
} | Unauthorized | Unavailable;

@route("/api/schedules")
@operationId("listSchedules")
@summary("List recurring schedules")
@doc("Asks the scheduler directly rather than the read model, so the next run times are current.")
@returnsDoc("Schedules ordered by name")
@get
op listSchedules(): {
	@statusCode statusCode: 200;

	@body body: {
		schedules: Schedule[];
	};
} | Unauthorized | NotImplemented | Unavailable;

@route("/api/runs")
@operationId("listRuns")
@summary("List runs")
@returnsDoc("A page of runs")
@get
op listRuns(
	@query @doc("Filter by run state") state?: string,
	@query @doc("Filter by flow name") flow?: string,
	@query @maxValue(100) limit?: integer = 20,
	@query offset?: integer = 0,
): {
	@statusCode statusCode: 200;

	@body body: {
		runs: RunSummary[];
		total: integer;
	};
} | Unauthorized | Unavailable;

@route("/api/runs")
@operationId("startRun")
@summary("Start a run")
@returnsDoc("Started. Starting twice with the same id returns the existing run id.")
@post
op startRun(@body body: StartRunRequest): {
	@statusCode statusCode: 201;

	@body body: {
		id: string;
	};
} | BadBody | Unauthorized | NotImplemented | Unavailable;

@route("/api/runs/{id}")
@operationId("getRun")
@summary("Get a run with all of its nodes")
@returnsDoc("The run and its nodes")
@get
op getRun(@path @doc("Run id") id: string): {
	@statusCode statusCode: 200;

	@body body: {
		run: RunDetail;
		nodes: RunNode[];
	};
} | Unauthorized | NotFound | Unavailable;

@route("/api/runs/{id}/retry")
@operationId("retryRun")
@summary("Resume a failed run from its failed nodes")
@post
op retryRun(@path @doc("Run id") id: string): MutationResponses | BadRunId | Unauthorized | NotImplemented | Unavailable;

@route("/api/runs/{id}/cancel")
@operationId("cancelRun")
@summary("Cancel a run")
@doc("Stops nodes that have not started and waits for running jobs to reach a terminal state.")
@post
op cancelRun(@path @doc("Run id") id: string): MutationResponses | BadRunId | Unauthorized | NotImplemented | Unavailable;

@route("/api/flows")
@operationId("listFlows")
@summary("List registered flows")
@returnsDoc("Flow names")
@get
op listFlows(): {
	@statusCode statusCode: 200;

	@body body: {
		flows: string[];
	};
} | Unauthorized | Unavailable;

@route("/api/openapi.json")
@operationId("getOpenApi")
@summary("This document")
@returnsDoc("The OpenAPI document")
@get
op getOpenApi(): {
	@statusCode statusCode: 200;
	@body body: {};
} | Unauthorized;

// metrics専用の応答, 説明が他の400 / 502と異なる
@doc("Invalid window or binding name")
model BadMetricsQuery {
	@statusCode statusCode: 400;
	@body body: Error;
}

@doc("Analytics Engine refused the query")
model AnalyticsRefused {
	@statusCode statusCode: 502;
	@body body: Error;
}
