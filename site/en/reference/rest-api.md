---
title: REST API
description: The REST API endpoints for managing jobs, Runs, schedules, and execution volume settings, and the request and response formats
publishedAt: 2026-07-22
updatedAt: 2026-10-25
---

<h1 id="rest-api">REST API</h1>

When you configure `auth`, Tsumugi handles requests to endpoints under `/api`.
If `auth` is not configured, Tsumugi responds to all requests with 404.
Authentication applies only to `/api/*`.
The dashboard HTML contains no job data, so it is served without requiring authentication.
If the dashboard is not authenticated, it shows a token input field.
Get the OpenAPI definition from [`GET /api/openapi.json`](#get-apiopenapijson).

<h2 id="共通のレスポンス">Common responses</h2>

| Status | Meaning |
| --- | --- |
| 401 | Authentication failed |
| 501 | The operation is not configured |
| 503 | Configuration is incomplete, or the service is temporarily unavailable |

The 503 body includes the reason.
If there are unapplied migrations, the body includes the names of the unapplied files.
If bindings are missing, the body includes the list of missing bindings.
If the service is temporarily unavailable, wait a while and retry.

In a configuration with no registered Flows, the endpoints that start, resume, and cancel a Run respond with 501.
`/api/openapi.json` responds even if configuration is incomplete.
If the runId format is invalid, endpoints that include `/api/runs/:id` respond with 400.

<h2 id="ジョブ">Jobs</h2>

<h3 id="get-apijobs">GET /api/jobs</h3>

Gets the list of jobs.
The response contains an array of jobs and the total count.

<h4 id="クエリパラメータ">Query parameters</h4>

| Name | Default | Description |
| --- | --- | --- |
| `state` | None | Filter by state |
| `binding` | None | Filter by binding name |
| `id` | None | Exact match on job ID |
| `unique_key` | None | Exact match on `uniqueKey` |
| `concurrency_key` | None | Exact match on `concurrencyKey` |
| `created_from` | None | Lower bound of `created_at`, in epoch milliseconds, inclusive |
| `created_to` | None | Upper bound of `created_at`, in epoch milliseconds, inclusive |
| `limit` | `20` | Maximum 100 |
| `offset` | `0` | Start position of the results |
| `sort` | `updated_at` | One of `updated_at`, `created_at`, `binding`, `state`, `priority`, `attempts` |
| `order` | `desc` | Ascending only when `asc` is specified |

If you specify multiple conditions, the list includes the jobs that satisfy all of them.
Key searches are exact matches; partial matches are not supported.
If you specify an invalid value for `sort` or `order`, the response uses the default sort order instead of returning 400.
If you specify a non-integer for `created_from` or `created_to`, that condition is ignored.

```json
{
  "jobs": [
    {
      "id": "MAIL#0:xxxxxxxxxxxxxxxxxxxxxxxx",
      "binding": "MAIL",
      "state": "FAILED",
      "priority": 0,
      "attempts": 3,
      "max_attempts": 3,
      "created_at": 1753000000000,
      "updated_at": 1753000060000,
      "dispatched_at": 1753000030000,
      "retryable": true
    }
  ],
  "total": 1
}
```

`retryable` is an estimate calculated from the retention period.
Whether a retry is possible is determined when the retry request is made.
A retry of a job past its retention period receives a 410 response.

<h3 id="get-apijobsid">GET /api/jobs/:id</h3>

Gets the details of a single job.
If the job is not found, the response is 404.

```json
{
  "job": {
    "id": "MAIL#0:xxxxxxxxxxxxxxxxxxxxxxxx",
    "binding": "MAIL",
    "state": "FAILED",
    "payload": "{\"to\":\"a@example.com\"}",
    "result": null,
    "priority": 0,
    "attempts": 3,
    "max_attempts": 3,
    "progress": null,
    "concurrency_key": "domain:example.com",
    "unique_key": null,
    "guarantee": "at-least-once",
    "created_at": 1753000000000,
    "updated_at": 1753000060000,
    "dispatched_at": 1753000030000,
    "run_after": null,
    "expires_at": null,
    "cancel_requested_at": null,
    "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    "retryable": true,
    "logs": [
      {
        "attempt": 1,
        "timestamp": 1753000011000,
        "message": "Payment requested"
      }
    ],
    "attempts_log": [
      {
        "attempt": 1,
        "state": "FAILED",
        "started_at": 1753000010000,
        "finished_at": 1753000012000,
        "error": "payment failed: 502"
      }
    ]
  }
}
```

| Field | Description |
| --- | --- |
| `result` | The return value of `perform`. `null` unless the job succeeded |
| `run_after` | The scheduled execution time of a scheduled job |
| `expires_at` | The deadline for starting execution. A job past its deadline transitions to `CANCELLED` without being executed |
| `cancel_requested_at` | The time a [cancellation of a running job](/en/guide/execution#実行中の取り消し) was requested. `null` if none was requested |
| `attempts_log` | The attempt history, newest attempt first |
| `logs` | Logs saved with `ctx.log()`. In the order received; each entry has the attempt number, the recording time (epoch milliseconds), and the message. An empty array if there are no logs. For the limits on the number of entries and the message length, see [Logs](/en/guide/performer#ログ) |
| `traceparent` | The trace information specified at enqueue time. `null` if not specified |

<h3 id="post-apijobs">POST /api/jobs</h3>

Enqueues a job.
The request body is JSON in the following format.

```json
{
  "binding": "MAIL",
  "payload": { "to": "a@example.com", "subject": "hi" },
  "maxAttempts": 5,
  "delayMs": 60000,
  "expiresInMs": 600000,
  "priority": 10,
  "concurrencyKey": "domain:example.com",
  "uniqueKey": "mail:a@example.com:hi",
  "partitionKey": "tenant-42",
  "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
}
```

`binding` and `payload` are required; specify a binding registered in `performers`.
`maxAttempts`, `delayMs`, `expiresInMs`, and `priority` must be integers.
Fields not in the example above (such as `timeoutMs` and `backoff`) are ignored, and default values are used.

`expiresInMs` is the execution deadline, counted from the time the job is enqueued.
A job past its deadline is not executed and transitions to `CANCELLED`.
`partitionKey` is the key that determines which shard a job is enqueued to, for a binding with `shards` set to 2 or more, and it is required for that binding.

`traceparent` is optional.
If it is not specified in the body, the value of the `traceparent` header is used; if both are specified, the value in the body takes precedence.
Use the W3C Trace Context version `00` format described in [Enqueuing jobs](/en/guide/enqueue#トレース情報).
The specified value is carried over on retries and passed to the performer's `ctx.traceparent`.

If `uniqueKey` matches an existing job, the response is also 201; no new job is created, and the body contains the existing job ID.

| Status | Meaning |
| --- | --- |
| 201 | Created. The body is `{ "id": "..." }` |
| 400 | Invalid JSON, or validation failure (unregistered binding, non-integer value, invalid `traceparent`, or a payload that exceeds the limit) |

<h3 id="post-apijobsidretry">POST /api/jobs/:id/retry</h3>

Transitions a `FAILED` or `STALLED` job to the `SCHEDULED` state.
A job that was deleted after its retention period cannot be retried.

| Status | Meaning |
| --- | --- |
| 200 | Retried |
| 400 | Invalid job ID format |
| 409 | The job is in neither the `FAILED` nor the `STALLED` state, or it belongs to a Run |
| 410 | The job does not exist, or it was deleted after its retention period |

For a 409, request again after the job's state changes.
To re-run a job that belongs to a Run, [resume the Run](#post-apirunsidretry).

<h3 id="post-apijobsidcancel">POST /api/jobs/:id/cancel</h3>

Cancels a job.
The targets are jobs in `SCHEDULED`, `QUEUED`, or `RUNNING`.

A `SCHEDULED` job transitions to `CANCELLED` immediately.
`QUEUED` and `RUNNING` jobs may already be executing, so the cancellation is recorded as a request.
In this case, the response includes `requested: true`.
The job transitions to `CANCELLED` when the performer acknowledges the request and finishes, or when no result is reported within `reaperGraceMs` (default 30 seconds) of the request.
For details, see [Cancelling a running job](/en/guide/execution#実行中の取り消し).

```json
{ "ok": true, "requested": true }
```

If you request cancellation again for a job that already has a cancellation request, the response is also `requested: true`.
A request for a job that has already finished receives a 409 response.
All other responses are the same as for `retry`.

<h3 id="post-apijobsbulk-retry">POST /api/jobs/bulk-retry</h3>

<h3 id="post-apijobsbulk-cancel">POST /api/jobs/bulk-cancel</h3>

Retries or cancels multiple jobs at once.
Specify the targets with either an array of job IDs or filter conditions.

To specify by job ID, provide `ids`; to specify by filter conditions, omit `ids`.

```json
{ "ids": ["MAIL#0:xxxxxxxxxxxxxxxxxxxxxxxx", "MAIL#0:yyyyyyyyyyyyyyyyyyyyyyyy"] }
```

```json
{ "binding": "MAIL", "state": "FAILED", "created_from": 1753000000000, "limit": 200 }
```

| Field | Required | Description |
| --- | --- | --- |
| `ids` | Optional | An array of job IDs. 1 to 200 entries |
| `binding` | Optional | Filter by binding name |
| `state` | Optional | For `bulk-retry`: `FAILED`, `STALLED`. For `bulk-cancel`: `SCHEDULED`, `QUEUED`, `RUNNING` |
| `unique_key` | Optional | Exact match |
| `concurrency_key` | Optional | Exact match |
| `created_from` | Optional | Lower bound of `created_at` |
| `created_to` | Optional | Upper bound of `created_at` |
| `limit` | Optional | The number of jobs to process in one request. At least 1; both the default and the maximum are 200 |

If you specify `ids`, the other conditions are ignored.
`created_from`, `created_to`, and `limit` must be integers.

If you omit `state` from the conditions, `bulk-retry` targets jobs in `FAILED` and `STALLED`, and `bulk-cancel` targets jobs in `SCHEDULED`, `QUEUED`, and `RUNNING`.
If you specify any other state, the response is 400.
In `bulk-retry`, jobs past `failedRetentionMs` are excluded from the targets.
In `bulk-cancel`, jobs that already have a cancellation request are excluded from the targets until `CANCELLED` is finalized.
When you specify jobs directly with `ids`, requesting again for a job that has already been requested does not cause it to be processed twice.

```json
{
  "ok": ["MAIL#0:xxxxxxxxxxxxxxxxxxxxxxxx"],
  "failed": [{ "id": "MAIL#0:yyyyyyyyyyyyyyyyyyyyyyyy", "reason": "gone" }],
  "remaining": 320
}
```

The status code is 200 even if processing fails for some of the jobs.
In `bulk-cancel`, jobs recorded as a cancellation request are also included in `ok`.
The `reason` in `failed` corresponds to the errors returned by the single-job retry and cancel endpoints.
`invalid-state` and `gone` correspond to 409 and 410, respectively.
`in-run` is for a retry of a job that belongs to a Run, and corresponds to 409.
When you specify conditions in `bulk-retry`, jobs that belong to a Run are excluded from the targets.
If `ids` contains a value that is not a valid job ID, that value is included in `failed` as `invalid-id`.

`remaining` is the number of jobs that were not processed because they exceeded `limit` when the targets were specified by conditions.
Resend the same request until it reaches 0.
When you specify `ids`, `remaining` is always 0.
A job that does not match the conditions at the time of the request is included in `failed`, even if it appears in the list.

<h3 id="post-apijobsidreschedule">POST /api/jobs/:id/reschedule</h3>

Changes the execution time of a scheduled job. The target is a job in `SCHEDULED`.

```json
{ "runAt": 1753003600000, "priority": 10 }
```

| Field | Required | Description |
| --- | --- | --- |
| `runAt` | Conditional | An absolute time. Cannot be specified together with `delayMs` |
| `delayMs` | Conditional | A time relative to the current time. Cannot be specified together with `runAt` |
| `priority` | Optional | Specify it to change the priority at the same time |

Specify exactly one of `runAt` and `delayMs`.
If you specify both, or neither, the response is 400.
`runAt`, `delayMs`, and `priority` must be integers.

The job ID does not change.
Duplicate detection by `uniqueKey` also continues to apply.
The status codes are the same as for `retry`.

<h2 id="集計と診断">Statistics and diagnostics</h2>

<h3 id="get-apistats">GET /api/stats</h3>

Gets the counts by state.

```json
{
  "byState": { "SCHEDULED": 12, "RUNNING": 3, "COMPLETED": 480, "FAILED": 2 },
  "oldestScheduledMs": 45000
}
```

`oldestScheduledMs` is the time elapsed, in milliseconds, since the oldest `SCHEDULED` job was enqueued.
If there are no `SCHEDULED` jobs, the value is `null`.

<h3 id="get-apimetrics">GET /api/metrics</h3>

Gets the failure rate and duration for each binding, based on the recorded metrics.

<h4 id="クエリパラメータ-1">Query parameters</h4>

| Name | Default | Description |
| --- | --- | --- |
| `hours` | `24` | The aggregation period in hours. An integer from 1 to 720 |
| `binding` | None | Filter by binding name |

```json
{
  "hours": 24,
  "bindings": [
    {
      "binding": "MAIL",
      "total": 1200,
      "failed": 18,
      "failureRate": 0.015,
      "avgDurationMs": 820,
      "maxDurationMs": 5400,
      "p95DurationMs": 2100,
      "avgAttempts": 1.04
    }
  ],
  "series": [{ "at": 1753000000000, "total": 50, "failed": 1, "avgDurationMs": 810 }]
}
```

Even for periods in which metrics are sampled, the response contains values close to the actual counts.
If `hours` is out of range, or `binding` is an invalid name, the response is 400.
In a configuration where `metrics` is not set, the response is 501.
502 is the response when the metrics could not be retrieved, and the body includes the reason.

<h3 id="get-apidiagnostics">GET /api/diagnostics</h3>

For each binding, gets the reasons that waiting jobs are not being executed. The response also includes the number of running jobs and the current execution volume settings.

```json
{
  "bindings": {
    "MAIL": {
      "active": 2,
      "blocked": { "paused": false, "capacity": true, "tokens": false, "perKey": false, "perKeyTokens": false },
      "policy": {
        "paused": false,
        "concurrency": 100,
        "perKeyConcurrency": 1,
        "rate": null,
        "perKeyRate": null,
        "agingIntervalMs": 60000,
        "reaperGraceMs": 30000,
        "queueWaitMs": 900000
      }
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `active` | The number of running jobs |
| `blocked` | The settings that are restricting execution of waiting jobs |
| `policy` | The execution volume settings currently in effect |

<h4 id="blocked">blocked</h4>

| Field | Restriction |
| --- | --- |
| `paused` | Paused |
| `capacity` | Concurrency |
| `tokens` | Rate |
| `perKey` | Per-key concurrency |
| `perKeyTokens` | Per-key rate |

<h3 id="get-apibindings">GET /api/bindings</h3>

Gets the list of binding names to which you can enqueue jobs.
All binding names registered in `performers` are included, including bindings that have never been run.

```json
{ "bindings": ["CHARGE", "MAIL"] }
```

<h2 id="実行量の設定">Execution volume settings</h2>

<h3 id="post-apibindingsbindingpolicy">POST /api/bindings/:binding/policy</h3>

Changes the execution volume settings at runtime.
The change takes precedence over the settings in `bindings`.

```json
{ "paused": true, "concurrency": 5 }
```

| Field | Description |
| --- | --- |
| `paused` | Pauses enqueueing. Monitoring of running jobs continues while paused |
| `concurrency` | The concurrency limit. An integer of 0 or more |
| `perKeyConcurrency` | The per-key concurrency limit. An integer of 0 or more |
| `rate` | `{ tokens, intervalMs }`. `null` removes the rate limit |
| `perKeyRate` | `{ tokens, intervalMs }`. The per-key rate. `null` removes the limit |
| `agingIntervalMs` | The aging interval. `null` disables aging |
| `reaperGraceMs` | The grace period before a job is judged unresponsive. An integer of 0 or more |
| `queueWaitMs` | The time a job may wait in Queues, applied only to jobs that have not started executing. An integer of 0 or more |

Only the fields you specify are changed; omitted fields are kept as they are.
On success, the response includes the settings after the change and the number of shards the change was applied to.
The following is an example of changing `paused` and `concurrency`.

```json
{
  "binding": "MAIL",
  "shards": 1,
  "policy": {
    "paused": true,
    "concurrency": 5,
    "perKeyConcurrency": 1,
    "rate": null,
    "perKeyRate": null,
    "agingIntervalMs": 60000,
    "reaperGraceMs": 30000,
    "queueWaitMs": 900000
  }
}
```

The change is applied to all shards that belong to the target binding.
If the binding is split into multiple shards, a network partition or a temporary failure may cause the change to fail for some shards.
In that case, the response is HTTP status code 500, and the body includes the numbers of the shards that failed.

```json
{ "error": "the change reached 3 of 4 shards, send the same request again", "binding": "MAIL", "shards": 4, "failed": [2] }
```

If you send the same request again, the change is applied to the remaining shards.
No matter how many times you send it, the resulting settings are the same.
After the change, the settings in `bindings` no longer apply.

<h3 id="post-apibindingsbindingpolicyreset">POST /api/bindings/:binding/policy/reset</h3>

Discards the runtime changes and reverts to the settings in `bindings`.
From the next enqueue, the settings in `bindings` apply again.

```json
{ "ok": true }
```

If the change fails for some shards, as with a `policy` change, the response is 500 and the body includes `failed`.

<h2 id="定期実行">Schedules</h2>

In a configuration that does not define `schedules`, the endpoints in this section respond with 501.
For details, see [Schedules](/en/guide/schedule).

<h3 id="get-apischedules">GET /api/schedules</h3>

Gets the list of schedules.
Unlike the job list, the state is reflected in real time.

```json
{
  "schedules": [
    {
      "name": "nightly",
      "kind": "flow",
      "target": "REPORT",
      "every_ms": null,
      "cron": "0 3 * * *",
      "time_zone": "Asia/Tokyo",
      "overlap": "skip",
      "paused": false,
      "next_occurrence_at": 1767722400000,
      "last_occurrence_at": 1767636000000,
      "last_fired_at": 1767636001200,
      "last_job_id": null,
      "last_run_id": "REPORT:nightly-1767636000000",
      "last_skipped_at": null,
      "skipped_count": 0,
      "last_error": null
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `name` | The schedule name. The key in `schedules` |
| `kind` | `job` or `flow` |
| `target` | A binding name or Flow name |
| `every_ms` | The fixed interval. `null` if `cron` is specified |
| `cron` | The cron expression. `null` if `everyMs` is specified |
| `time_zone` | The IANA time zone used for cron and display. `UTC` for fixed intervals |
| `overlap` | `skip` or `overlap` |
| `paused` | Whether the schedule is paused |
| `next_occurrence_at` | The next scheduled run |
| `last_occurrence_at` | The scheduled time of the previous run. `null` if it has never run |
| `last_fired_at` | The actual time of the previous run. The difference from `last_occurrence_at` is the delay in execution |
| `last_job_id` | The ID of the job enqueued by the previous run. `null` if `kind` is `flow` |
| `last_run_id` | The ID of the Run started by the previous run. `null` if `kind` is `job` |
| `last_skipped_at` | The time of the most recent occurrence that was not run. `null` if there is none |
| `skipped_count` | The number of occurrences that were not run because the previous run had not finished |
| `last_error` | The reason the previous run failed. `null` if it succeeded |

Fields ending in `_at` are in epoch milliseconds.

<h3 id="post-apischedulesnamepause">POST /api/schedules/:name/pause</h3>

While a schedule is paused, scheduled executions do not occur.
Jobs enqueued before the pause are not affected.

```json
{ "ok": true }
```

<h3 id="post-apischedulesnameresume">POST /api/schedules/:name/resume</h3>

Resumes a paused schedule.
Occurrences that elapsed while the schedule was paused are not run.
The next run after resuming is the first scheduled time after the moment of resuming.

```json
{ "ok": true }
```

<h3 id="post-apischedulesnametrigger">POST /api/schedules/:name/trigger</h3>

Runs the schedule once immediately.

```json
{ "id": "REPORT:nightly-1767650000000-1-manual", "kind": "flow" }
```

`id` is the ID of the enqueued job or the ID of the started Run.
`kind` indicates whether `id` refers to a job or a Run.
It runs even while the schedule is paused, and the `overlap` check is not performed.
The time of the next scheduled run does not change.
If the execution fails, the response is 500 with the error details.
The value of `last_error` in the list is the same as these error details.

<h2 id="run">Run</h2>

<h3 id="get-apiflows">GET /api/flows</h3>

Gets the registered Flow names.
All Flow names registered in `flows` are included, whether or not they have been run.

```json
{ "flows": ["GREETINGS", "PIPELINE"] }
```

<h3 id="get-apiruns">GET /api/runs</h3>

Gets the list of Runs.
Each Run includes the progress of its nodes.

<h4 id="クエリパラメータ-2">Query parameters</h4>

| Name | Default | Description |
| --- | --- | --- |
| `state` | None | One of `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED` |
| `flow` | None | Filter by Flow name |
| `limit` | 20 | Maximum 100 |
| `offset` | 0 | Paging |

```json
{
  "runs": [
    {
      "id": "GREETINGS:cl9x0a1b2c3d",
      "flow": "GREETINGS",
      "state": "RUNNING",
      "node_total": 6,
      "node_done": 4,
      "node_failed": 0,
      "created_at": 1767225600000,
      "updated_at": 1767225603000
    }
  ],
  "total": 1
}
```

<h3 id="get-apirunsid">GET /api/runs/:id</h3>

Gets a single Run and the nodes it contains.
The nodes include both static nodes defined in advance and nodes added dynamically at runtime.

```json
{
  "run": {
    "id": "GREETINGS:cl9x0a1b2c3d",
    "flow": "GREETINGS",
    "state": "RUNNING",
    "input": "{\"prefix\":\"hello\"}",
    "node_total": 6,
    "node_done": 4,
    "node_failed": 0,
    "created_at": 1767225600000,
    "updated_at": 1767225603000,
    "parent_run_id": null,
    "parent_node_id": null,
    "retryable": false
  },
  "nodes": [
    {
      "id": "greet",
      "binding": "GREET",
      "state": "RUNNING",
      "container": true,
      "parent": null,
      "origin": "static",
      "after": ["list"],
      "job_id": null,
      "child_run_id": null,
      "result": null,
      "error": null,
      "position": 1,
      "created_at": 1767225600000,
      "updated_at": 1767225603000
    }
  ]
}
```

A node whose `container` is `true` is a fan-out node.
A fan-out node has no job, so `job_id` is `null`.
`result` contains the aggregated values of the child nodes.
A node that has a `parent` was added at runtime.
`origin` is `fanOut` or `spawn`.
For a Run started as a subflow, `parent_run_id` and `parent_node_id` contain the IDs of the parent Run and node.
For a subflow node, `child_run_id` contains the runId of the child Run that it started.

<h3 id="post-apiruns">POST /api/runs</h3>

Starts a Run.
The request body is JSON containing the Flow name and the input.

```json
{ "flow": "GREETINGS", "input": { "prefix": "hello" }, "id": "order-1234" }
```

| Field | Required | Description |
| --- | --- | --- |
| `flow` | Required | The name of a registered Flow. 400 if it is not registered |
| `input` | Required | Any JSON. No type checking is applied |
| `id` | Optional | The local part of the runId. A second start with the same ID responds with the existing runId |
| `deadlineMs` | Optional | The deadline for the whole Run, in milliseconds. A positive integer. When the deadline is exceeded, the Run is aborted and transitions to `FAILED`. Takes precedence over the deadline in the Flow definition |

On success, the response is 201 and the body contains the runId of the started Run.
The runId in the following example is `GREETINGS:order-1234`, built from `flow` and `id`.

```json
{ "id": "GREETINGS:order-1234" }
```

<h3 id="post-apirunsidretry">POST /api/runs/:id/retry</h3>

Resumes a failed Run.
The results of completed nodes are carried over as they are.
Nodes in `FAILED`, `STALLED`, `SKIPPED`, and `CANCELLED` are run again as not yet executed.
Among the child nodes created by a fan-out, only those that were aborted because the Run exceeded its deadline or the node count limit are run again.
Child nodes that ran and failed are not run again.
Completed nodes downstream of a node that will be run again are also run again as not yet executed.
The same rule applies to nodes further downstream.
A fan-out node, a subflow node, or a node that added child nodes with `ctx.spawn` is not run again if it has completed, even when it is downstream.

Only a `FAILED` Run can be resumed.
A Run in any other state receives a 409 response.
A Run that does not exist, or one past its retention period, receives a 410 response.

<h3 id="post-apirunsidcancel">POST /api/runs/:id/cancel</h3>

Cancels a Run.
Nodes that have not started are not started, and a [cancellation request](/en/guide/execution#実行中の取り消し) is sent to running nodes.
Running jobs are not stopped.
The Run transitions to `CANCELLED` when the performer acknowledges the request and finishes, or when no result is reported within `reaperGraceMs` (default 30 seconds) of the request.
Only a `RUNNING` Run can be cancelled.

<h2 id="get-apiopenapijson">GET /api/openapi.json</h2>

Gets the OpenAPI 3.1 definition that describes the parameters and response formats of all endpoints.
