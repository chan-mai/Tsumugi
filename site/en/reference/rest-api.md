---
title: REST API
description: The endpoints of the REST API for working with jobs, Runs, schedules, and throughput settings, and the request and response formats
publishedAt: 2026-07-22
updatedAt: 2026-10-25
---

<h1 id="rest-api">REST API</h1>

When `auth` is configured, Tsumugi handles requests to endpoints under `/api`.
If it is not configured, Tsumugi responds to every request with 404.
Authentication applies only to `/api/*`.
The dashboard HTML contains no job data, so it is served without requiring authentication.
If the request is not authenticated, the dashboard shows a token input field.
Get the OpenAPI definition with [`GET /api/openapi.json`](#get-apiopenapijson).

<h2 id="共通のレスポンス">Common responses</h2>

| Status | Meaning |
| --- | --- |
| 401 | Authentication failed |
| 501 | The operation is not configured |
| 503 | Configuration is incomplete, or the service is temporarily unavailable |

The 503 body includes the reason.
If there are unapplied migrations, the body includes the names of the unapplied files.
If bindings are missing, the body includes the list of missing bindings.
If the service is temporarily unavailable, wait and retry.

In a configuration with no registered Flow, the endpoints that start, resume, and cancel a Run respond with 501.
`/api/openapi.json` responds even when configuration is incomplete.
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
| `created_from` | None | Lower bound of `created_at`. In epoch milliseconds, inclusive |
| `created_to` | None | Upper bound of `created_at`. In epoch milliseconds, inclusive |
| `limit` | `20` | Maximum 100 |
| `offset` | `0` | Starting position |
| `sort` | `updated_at` | One of `updated_at`, `created_at`, `binding`, `state`, `priority`, `attempts` |
| `order` | `desc` | Ascending only when `asc` is specified |

When multiple conditions are specified, the list includes the jobs that satisfy all of them.
Key searches are exact match; partial match is not available.
If an invalid value is given for `sort` or `order`, the response uses the default order instead of returning 400.
If a non-integer is given for `created_from` or `created_to`, that condition is ignored.

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
Whether a retry is allowed is determined when the retry request is made.
Retrying a job that is past its retention period returns 410.

<h3 id="get-apijobsid">GET /api/jobs/:id</h3>

Gets the details of one job.
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
| `cancel_requested_at` | The time at which [cancellation of a running job](/en/guide/execution#実行中の取り消し) was requested. `null` if not requested |
| `attempts_log` | The attempt history, newest attempt first |
| `logs` | Logs saved with `ctx.log()`. In the order received; each entry has the attempt number, the recording time (epoch milliseconds), and the message. An empty array if there are no logs. For the limits on the number of entries and the message length, see [Logs](/en/guide/performer#ログ) |
| `traceparent` | The trace information specified at enqueue. `null` if not specified |

<h3 id="post-apijobs">POST /api/jobs</h3>

Enqueues a job.
The request body is JSON in the following format:

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
Fields that are not in the example above (such as `timeoutMs` and `backoff`) are ignored, and the default values are used.

`expiresInMs` is the deadline for execution, counted from the time the job is enqueued.
A job past its deadline is not executed and transitions to `CANCELLED`.
`partitionKey` is the key that determines which shard a job is enqueued to, for a binding with `shards` set to 2 or more, and it is required for that binding.

`traceparent` is optional.
If it is not specified in the body, the value of the `traceparent` header is used; if both are specified, the value in the body takes precedence.
Use the W3C Trace Context version `00` format described in [Enqueuing jobs](/en/guide/enqueue#トレース情報) for the value.
The specified value is carried over on retries and passed to the performer as `ctx.traceparent`.

If `uniqueKey` matches an existing job, the response is also 201, no new job is created, and the body contains the existing job ID.

| Status | Meaning |
| --- | --- |
| 201 | Created. The body is `{ "id": "..." }` |
| 400 | Invalid JSON, or validation failure (unregistered binding, non-integer value, invalid `traceparent`) |

<h3 id="post-apijobsidretry">POST /api/jobs/:id/retry</h3>

Transitions a `FAILED` or `STALLED` job to the `SCHEDULED` state.
A job that was deleted after its retention period cannot be retried.

| Status | Meaning |
| --- | --- |
| 200 | Retried |
| 400 | Invalid job ID format |
| 409 | The job state is neither `FAILED` nor `STALLED` |
| 410 | The job does not exist, or was deleted after its retention period |

For 409, wait until the job's state changes, then request again.

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

If cancellation is requested again for a job whose cancellation has already been requested, the response is also `requested: true`.
A request for a job that has finished returns 409.
All other responses are the same as for `retry`.

<h3 id="post-apijobsbulk-retry">POST /api/jobs/bulk-retry</h3>

<h3 id="post-apijobsbulk-cancel">POST /api/jobs/bulk-cancel</h3>

Retries or cancels multiple jobs at once.
Specify the targets either as an array of job IDs or as filter conditions.

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
| `limit` | Optional | The number of jobs to process in one request. At least 1; the default and the maximum are both 200 |

When `ids` is specified, the other conditions are ignored.
Specify integers for `created_from`, `created_to`, and `limit`.

If `state` is omitted from the conditions, `bulk-retry` targets jobs in `FAILED` and `STALLED`, and `bulk-cancel` targets jobs in `SCHEDULED`, `QUEUED`, and `RUNNING`.
If any other state is specified, the response is 400.
In `bulk-retry`, jobs that are past `failedRetentionMs` are excluded from the targets.
In `bulk-cancel`, jobs for which cancellation has already been requested are excluded until `CANCELLED` is finalized.
When jobs are specified directly with `ids`, requesting again for a job that has already been requested does not process it twice.

```json
{
  "ok": ["MAIL#0:xxxxxxxxxxxxxxxxxxxxxxxx"],
  "failed": [{ "id": "MAIL#0:yyyyyyyyyyyyyyyyyyyyyyyy", "reason": "gone" }],
  "remaining": 320
}
```

Even if processing fails for some of the jobs, the status code is 200.
In `bulk-cancel`, jobs whose cancellation was recorded as a request are also included in `ok`.
The `reason` in `failed` corresponds to the errors returned by the endpoints that retry and cancel a single job.
`invalid-state` and `gone` correspond to 409 and 410, respectively.
If `ids` contains a value that is not a valid job ID, that value is included in `failed` as `invalid-id`.

`remaining` is the number of jobs that were not processed because they exceeded `limit`, when the targets are specified by conditions.
Resend the same request until it reaches 0.
When the targets are specified by `ids`, `remaining` is always 0.
A job that does not match the conditions at the time of the request is included in `failed`, even if it appears in the list.

<h3 id="post-apijobsidreschedule">POST /api/jobs/:id/reschedule</h3>

Changes the execution time of a scheduled job. The target is a `SCHEDULED` job.

```json
{ "runAt": 1753003600000, "priority": 10 }
```

| Field | Required | Description |
| --- | --- | --- |
| `runAt` | Conditional | An absolute time. Cannot be specified together with `delayMs` |
| `delayMs` | Conditional | A time relative to the current time. Cannot be specified together with `runAt` |
| `priority` | Optional | Specify to change the priority at the same time |

Specify exactly one of `runAt` and `delayMs`.
If both are specified, or neither is specified, the response is 400.
`runAt`, `delayMs`, and `priority` must be integers.

The job ID does not change.
Duplicate detection by `uniqueKey` also continues.
The status codes are the same as for `retry`.

<h2 id="集計と診断">Statistics and diagnostics</h2>

<h3 id="get-apistats">GET /api/stats</h3>

Gets the number of jobs in each state.

```json
{
  "byState": { "SCHEDULED": 12, "RUNNING": 3, "COMPLETED": 480, "FAILED": 2 },
  "oldestScheduledMs": 45000
}
```

`oldestScheduledMs` is the time in milliseconds that has elapsed since the oldest `SCHEDULED` job was enqueued.
If there are no `SCHEDULED` jobs, the value is `null`.

<h3 id="get-apimetrics">GET /api/metrics</h3>

Gets the failure rate and duration for each binding, based on the recorded metrics.

<h4 id="クエリパラメータ-1">Query parameters</h4>

| Name | Default | Description |
| --- | --- | --- |
| `hours` | `24` | The number of hours to aggregate. An integer from 1 to 720 |
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

Even for periods in which metrics are sampled, the values are close to the actual counts.
If `hours` is out of range, or `binding` is an invalid name, the response is 400.
In a configuration without `metrics`, the response is 501.
502 is the response when the metrics could not be retrieved, and the body includes the reason.

<h3 id="get-apidiagnostics">GET /api/diagnostics</h3>

Gets, for each binding, the reasons that waiting jobs are not being executed. It also includes the number of running jobs and the current throughput settings.

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
        "reaperGraceMs": 30000
      }
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `active` | The number of running jobs |
| `blocked` | The settings that are limiting the execution of waiting jobs |
| `policy` | The throughput settings currently in effect |

<h4 id="blocked">blocked</h4>

| Field | Limit |
| --- | --- |
| `paused` | Paused |
| `capacity` | Concurrency |
| `tokens` | Rate |
| `perKey` | Per-key concurrency |
| `perKeyTokens` | Per-key rate |

<h3 id="get-apibindings">GET /api/bindings</h3>

Gets the list of binding names to which jobs can be enqueued.
All binding names registered in `performers` are included, even bindings that have never been executed.

```json
{ "bindings": ["CHARGE", "MAIL"] }
```

<h2 id="実行量の設定">Throughput settings</h2>

<h3 id="post-apibindingsbindingpolicy">POST /api/bindings/:binding/policy</h3>

Changes the throughput settings at runtime.
The changes take precedence over the `bindings` settings.

```json
{ "paused": true, "concurrency": 5 }
```

| Field | Description |
| --- | --- |
| `paused` | Pauses enqueuing. Monitoring of running jobs continues while paused |
| `concurrency` | Concurrency. An integer of 0 or greater |
| `perKeyConcurrency` | Per-key concurrency. An integer of 0 or greater |
| `rate` | `{ tokens, intervalMs }`. `null` removes the rate limit |
| `perKeyRate` | `{ tokens, intervalMs }`. The per-key rate. `null` removes the limit |
| `agingIntervalMs` | The aging interval. `null` disables aging |
| `reaperGraceMs` | The grace period before a job is judged unresponsive. An integer of 0 or greater |

Only the specified fields are changed; omitted fields are kept.
On success, the response includes the settings after the change and the number of shards to which the change was applied.
The following is an example for a change to `paused` and `concurrency`.

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
    "reaperGraceMs": 30000
  }
}
```

The change is applied to all shards that belong to the target binding.
If the binding is split into shards, a network partition or a temporary failure may cause the change to fail on some shards.
In that case, the response is HTTP status code 500, and the body includes the numbers of the shards that failed.

```json
{ "error": "the change reached 3 of 4 shards, send the same request again", "binding": "MAIL", "shards": 4, "failed": [2] }
```

Sending the same request again applies the change to the remaining shards.
The resulting settings are the same no matter how many times the request is sent.
After the change, the `bindings` settings no longer apply.

<h3 id="post-apibindingsbindingpolicyreset">POST /api/bindings/:binding/policy/reset</h3>

Discards the runtime changes and returns to the `bindings` settings.
From the next enqueue, the `bindings` settings apply again.

```json
{ "ok": true }
```

If applying the reset fails on some shards, as with a `policy` change, the response is 500 and the body includes `failed`.

<h2 id="定期実行">Schedules</h2>

In a configuration without `schedules` defined, the endpoints in this section respond with 501.
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
| `name` | The name of the schedule. The key in `schedules` |
| `kind` | `job` or `flow` |
| `target` | The binding name or Flow name |
| `every_ms` | The fixed interval. `null` when `cron` is specified |
| `cron` | The cron expression. `null` when `everyMs` is specified |
| `time_zone` | The IANA time zone used for cron and for display. `UTC` for a fixed interval |
| `overlap` | `skip` or `overlap` |
| `paused` | Whether the schedule is paused |
| `next_occurrence_at` | The next scheduled execution |
| `last_occurrence_at` | The scheduled time of the previous execution. `null` if it has never been executed |
| `last_fired_at` | The actual time of the previous execution. The difference from `last_occurrence_at` is the execution delay |
| `last_job_id` | The ID of the job enqueued by the previous execution. `null` when `kind` is `flow` |
| `last_run_id` | The ID of the Run started by the previous execution. `null` when `kind` is `job` |
| `last_skipped_at` | The time of the most recent occurrence that was not executed. `null` if there is none |
| `skipped_count` | The number of occurrences that were not executed because the previous execution had not finished |
| `last_error` | The reason the previous execution failed. `null` if it succeeded |

Fields whose names end in `_at` are epoch milliseconds.

<h3 id="post-apischedulesnamepause">POST /api/schedules/:name/pause</h3>

While a schedule is paused, no periodic executions take place.
Jobs enqueued before the pause are not affected.

```json
{ "ok": true }
```

<h3 id="post-apischedulesnameresume">POST /api/schedules/:name/resume</h3>

Resumes a paused schedule.
Occurrences that passed while the schedule was paused are not executed.
The next execution after resuming is the first scheduled time after the moment of resuming.

```json
{ "ok": true }
```

<h3 id="post-apischedulesnametrigger">POST /api/schedules/:name/trigger</h3>

Executes the schedule once, immediately.

```json
{ "id": "REPORT:nightly-1767650000000-1-manual", "kind": "flow" }
```

`id` is the ID of the job that was enqueued or the ID of the Run that was started.
`kind` indicates whether `id` refers to a job or a Run.
The schedule is executed even while paused, and the `overlap` check is not performed.
The time of the next periodic execution does not change.
If the execution fails, the response is 500 with the error details.
The value of `last_error` in the list is the same as these error details.

<h2 id="run">Run</h2>

<h3 id="get-apiflows">GET /api/flows</h3>

Gets the registered Flow names.
All Flow names registered in `flows` are included, whether or not they have been executed.

```json
{ "flows": ["GREETINGS", "PIPELINE"] }
```

<h3 id="get-apiruns">GET /api/runs</h3>

Gets the list of Runs.
For each Run, the progress of its nodes is included.

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

Gets one Run and the nodes it contains.
The nodes include both the static nodes defined in advance and the nodes added dynamically at run time.

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
`result` contains the aggregate values of the child nodes.
A node that has a `parent` was added at run time.
`origin` is `fanOut` or `spawn`.
For a Run that was started as a subflow, `parent_run_id` and `parent_node_id` contain the IDs of the parent Run and node.
For a subflow node, `child_run_id` contains the runId of the child Run that was started.

<h3 id="post-apiruns">POST /api/runs</h3>

Starts a Run.
The request body is JSON that contains the Flow name and the input.

```json
{ "flow": "GREETINGS", "input": { "prefix": "hello" }, "id": "order-1234" }
```

| Field | Required | Description |
| --- | --- | --- |
| `flow` | Required | A registered Flow name. 400 if it is not registered |
| `input` | Required | Any JSON. No type checking is applied |
| `id` | Optional | The local part of the runId. A second start with the same ID responds with the existing runId |
| `deadlineMs` | Optional | The deadline for the whole Run, in milliseconds. A positive integer. When the deadline is exceeded, the Run is aborted and transitions to `FAILED`. Takes precedence over the deadline in the Flow definition |

On success, the response is 201 and the body contains the runId of the Run that was started.
The runId in the following example is `GREETINGS:order-1234`, which is built from `flow` and `id`.

```json
{ "id": "GREETINGS:order-1234" }
```

<h3 id="post-apirunsidretry">POST /api/runs/:id/retry</h3>

Resumes a failed Run.
The results of completed nodes are carried over as they are.
Nodes in `FAILED`, `STALLED`, `SKIPPED`, and `CANCELLED` are executed again as not yet executed.
Of the child nodes created by fan-out, only the child nodes that were aborted because the Run's deadline passed are executed again.
Child nodes that were executed and failed are not executed again.

Only a `FAILED` Run can be resumed.
A Run in any other state responds with 409.
A Run that does not exist, or a Run that is past its retention period, responds with 410.

<h3 id="post-apirunsidcancel">POST /api/runs/:id/cancel</h3>

Cancels a Run.
Nodes that have not started are not started, and a [cancellation request](/en/guide/execution#実行中の取り消し) is sent to the nodes that are running.
Running jobs are not stopped.
The Run transitions to `CANCELLED` when the performer acknowledges the request and finishes, or when no result is reported within `reaperGraceMs` (default 30 seconds) of the request.
Only a `RUNNING` Run can be cancelled.

<h2 id="get-apiopenapijson">GET /api/openapi.json</h2>

Gets the OpenAPI 3.1 definition that describes the parameters and response formats of all endpoints.
