---
title: Configuration
description: Types and default values of the settings passed to defineTsumugi, and the wrangler binding configuration
publishedAt: 2026-07-22
updatedAt: 2026-10-30
---

<h1 id="設定">Configuration</h1>

<h2 id="definetsumugi">defineTsumugi</h2>

```ts
const tsumugi = defineTsumugi({
  performers,
  flows,
  schedules,
  runs,
  bindings,
  auth,
  ui,
  retention,
  metrics,
  onFailure,
  onSettled,
  onEnqueue,
});
```

`defineTsumugi` does not need type arguments.
The payload type for each binding and `Env` are inferred automatically from the contents of `performers`.

| Name | Required | Description |
| --- | --- | --- |
| `performers` | ○ | Performer modules. The source from which payload and required-key types are derived |
| `flows` |  | Mapping of Flow names to definitions. The `RUN` binding is required when specified |
| `schedules` |  | Definitions of recurring execution. The `SCHEDULER` binding is required when specified |
| `runs` |  | Limits and retention period for Runs |
| `bindings` |  | Shard count, execution limits, and retention period for each binding |
| `auth` |  | Authentication. When not set, all requests to the REST API and the dashboard return 404 |
| `ui` |  | `ui()` from `tsumugi/ui`. When not specified, the dashboard bundle is not included |
| `retention` |  | Retention period for lists |
| `metrics` |  | Settings for reading metrics. When not set, `GET /api/metrics` returns 501 |
| `onFailure` |  | Binding name to notify of failed jobs. When not set, no notification is sent |
| `onSettled` |  | Binding name to notify of finished jobs, and the states to notify |
| `onEnqueue` |  | Function that sets default execution options for each enqueue |

<h3 id="戻り値">Return values</h3>

| Name | Description |
| --- | --- |
| `fetch`, `queue`, `scheduled` | `ExportedHandler` handlers to include in the default export |
| `jobs(env)` | Typed enqueue object (`JobQueue<M>`) |
| `enqueue(env, input)` | Typed enqueue of a single job. Returns the job ID |
| `enqueueMany(env, inputs)` | Enqueues multiple jobs in the same format as `enqueue` |
| `shardFor(env, binding, partitionKey?)` | Stub of the shard to enqueue to |
| `start(env, flow, input, options?)` | Starts a Run. Returns the runId |
| `runFor(env, runId)` | Stub of the Run |
| `runClass` | Run class to register in wrangler |
| `schedulerClass` | Class for recurring execution to register in wrangler |

Even when `flows` is not specified, the return value includes `start`, `runFor`, and `runClass`.
Passing a Flow name that is not defined in `flows` to `start` throws an exception.
Calling `runFor` when the `RUN` binding does not exist also throws an exception.
For the differences between enqueue methods, see [Enqueueing jobs](/en/guide/enqueue#投入方法).

<h2 id="auth">auth</h2>

| Function | Description |
| --- | --- |
| `bearerAuth` | Authentication with a single token |
| `cloudflareAccess` | Verification of Cloudflare Access JWTs |
| `unsafeNoAuth` | No authentication |

You can pass a custom authentication function to `auth`.
The function takes `request` and `env` as arguments and returns a `Response` or `undefined`.
For details, see [Dashboard and authentication](/en/guide/dashboard#独自の認証).
If `auth` is not set, all requests to the REST API and the dashboard receive a 404 response.
For the effects of `unsafeNoAuth`, see [Dashboard and authentication](/en/guide/dashboard#認証しない構成).

<h2 id="metrics">metrics</h2>

```ts
const tsumugi = defineTsumugi({
  performers,
  auth: bearerAuth((env: Env) => env.TSUMUGI_TOKEN),
  metrics: (env: Env) =>
    env.CF_ACCOUNT_ID && env.CF_API_TOKEN
      ? { accountId: env.CF_ACCOUNT_ID, apiToken: env.CF_API_TOKEN, dataset: 'tsumugi_jobs' }
      : undefined,
});
```

`metrics` configures how the recorded metrics are read from the dashboard and the REST API.
`apiToken` is an API token with Account Analytics read permission, and you should set it as a Secret.
`dataset` is the dataset name written in `analytics_engine_datasets` in the wrangler configuration file.
If `metrics` is not specified, `GET /api/metrics` responds with 501, and the dashboard sidebar does not show a metrics item.

<h2 id="onfailure">onFailure</h2>

```ts
const tsumugi = defineTsumugi({
  performers,
  onFailure: 'NotifyFailure',
});
```

`onFailure` is the binding name of the performer that is notified of failed jobs.
The performer to notify must be one that receives `FailureNotice`.
For the notification conditions and the contents of `FailureNotice`, see [Failure notifications](/en/guide/execution#失敗の通知).

<h2 id="onsettled">onSettled</h2>

```ts
const tsumugi = defineTsumugi({
  performers,
  onSettled: { binding: 'NotifySettled', states: ['COMPLETED', 'FAILED'] },
});
```

`onSettled` specifies the binding name of the performer that is notified of finished jobs, and the states to notify.
`binding` must be a performer that receives `SettledNotice`.
`states` is required, and you choose from `COMPLETED`, `FAILED`, `CANCELLED`, and `STALLED`.
Specifying an empty array or an invalid state throws an exception in `defineTsumugi`.
For the notification conditions and the contents of `SettledNotice`, see [Completion notifications](/en/guide/execution#終了の通知).

<h2 id="onenqueue">onEnqueue</h2>

```ts
const tsumugi = defineTsumugi({
  performers,
  onEnqueue: (input) => (input.binding === 'SlowJob' ? { timeoutMs: 300_000 } : undefined),
});
```

`onEnqueue` is a function that sets default execution options each time a job is enqueued.
Values explicitly specified by the user always take precedence.
For the enqueue methods it applies to and the options to which the defaults apply, see [Defaults at enqueue time](/en/guide/execution#投入時の既定値).

<h2 id="runsettings">RunSettings</h2>

| Name | Default | Description |
| --- | --- | --- |
| `maxNodes` | `10000` | Maximum number of nodes in a single Run. The Run fails when this is exceeded |
| `maxDepth` | `3` | Maximum nesting depth of subflows. The Run fails when this is exceeded |
| `sweepAfterMs` | 5 minutes | Retention time for finished Runs |
| `failedRetentionMs` | 7 days | Retention time for `FAILED` Runs. Runs within this period can be resumed |

<h2 id="bindingconfig">BindingConfig</h2>

| Name | Default | Description |
| --- | --- | --- |
| `shards` | `1` | Number of shards. `partitionKey` is required when this is 2 or more |
| `policy` | See below | Execution limits and aging |
| `sweepAfterMs` | 5 minutes | Retention time for `COMPLETED` and `CANCELLED` jobs |
| `failedRetentionMs` | 7 days | Retention time for `FAILED` and `STALLED` jobs. Jobs within this period can be retried |

<h2 id="policy">Policy</h2>

| Name | Default | Description |
| --- | --- | --- |
| `paused` | `false` | Pauses enqueueing |
| `concurrency` | `100` | Maximum number of concurrent executions |
| `perKeyConcurrency` | `1` | Maximum number of concurrent executions per `concurrencyKey` |
| `rate` | `null` | `{ tokens, intervalMs }`. Runs up to `tokens` jobs per `intervalMs` |
| `perKeyRate` | `null` | `{ tokens, intervalMs }`. Runs up to `tokens` jobs per `intervalMs` for each key |
| `agingIntervalMs` | `60000` | Wait time until the effective priority increases by 1. `null` disables aging |
| `reaperGraceMs` | `30000` | Grace period after `timeoutMs` elapses before a job whose result has not been reported is judged unresponsive |
| `queueWaitMs` | `900000` | Time a job may wait in Queues, added to the deadline for judging a job that has not started execution (`QUEUED`) unresponsive |

<h2 id="enqueueinput">EnqueueInput</h2>

| Name | Default | Description |
| --- | --- | --- |
| `binding` |  | Binding name to enqueue to |
| `payload` |  | Value passed to the performer |
| `priority` | `0` | Numeric priority. Higher values run first |
| `maxAttempts` | `3` | Maximum number of attempts |
| `backoff` | exponential | `fixed` or `exponential` |
| `timeoutMs` | `60000` | Time until timeout |
| `delayMs` |  | Delay before execution starts |
| `runAt` |  | Time at which execution starts. Cannot be specified together with `delayMs` |
| `expiresInMs` |  | Expiration, counted from the enqueue time |
| `expiresAt` |  | Expiration time. Takes precedence over `expiresInMs` |
| `guarantee` | `at-least-once` | `at-least-once` or `at-most-once` |
| `concurrencyKey` |  | Key for running jobs with the same key in order |
| `uniqueKey` |  | Key for deduplication |
| `uniqueForMs` | 24 hours | Period during which `uniqueKey` is used to detect duplicates |
| `partitionKey` |  | Key that determines the shard to enqueue to when shards are partitioned |

For details on the options, see [Enqueueing jobs](/en/guide/enqueue#オプション).

The `enqueue` of `createClient` takes `EnqueueInput` as its argument.
For the input accepted by the `enqueue` of `defineTsumugi`, the payload and required-key types are derived for each `binding`.

<h3 id="backoffの既定値">Default value of backoff</h3>

```ts
{ kind: 'exponential', baseMs: 1_000, factor: 2, maxMs: 3_600_000, jitter: true }
```

<h2 id="sweepoptions">SweepOptions</h2>

| Name | Default | Description |
| --- | --- | --- |
| `olderThanMs` | 7 days | How long finished jobs and Runs remain in lists |
| `limit` | `1000` | Maximum number of items deleted in one sweep, counted separately for jobs and Runs |

When a cron trigger is configured, finished jobs and Runs are removed from lists after `olderThanMs` has elapsed.

The period during which a Run can be resumed is set in `runs`.
A `FAILED` Run is removed from lists after the longer of `olderThanMs` and `runs.failedRetentionMs` has elapsed.
`FAILED` and `STALLED` jobs are also removed from lists after the longer of `olderThanMs` and the binding's `failedRetentionMs` has elapsed.

<h2 id="wranglerのbinding">wrangler bindings</h2>

| binding | Type | Required | Purpose |
| --- | --- | --- | --- |
| `JOB_SHARD` | Durable Object | ○ | Job management |
| `RUN` | Durable Object |  | Run management. Required when using `flows` |
| `SCHEDULER` | Durable Object |  | Recurring execution. Required when using `schedules` |
| `TSUMUGI_DB` | D1 | ○ | Lists and search |
| `TSUMUGI_QUEUE` | Queues | ○ | Execution of performers |
| `TSUMUGI_METRICS` | Analytics Engine |  | Recording metrics |

If `TSUMUGI_METRICS` does not exist, metrics are not recorded.
Other behavior is unchanged.
If any other required binding is missing, the REST API responds with 503, and the response body includes a list of the missing bindings.

A performer specified with `remote()` requires a Service Binding.
For the binding name, do not use a fixed name; specify the key from `performers` as is.

```jsonc
"services": [
  { "binding": "MAIL", "service": "my-mailer", "entrypoint": "SendMail" },
]
```

A Worker that has no performers and is used only to enqueue jobs needs only the `JOB_SHARD` binding.

<h2 id="サブパス">Subpaths</h2>

| Import source | Description |
| --- | --- |
| `tsumugi` | `defineTsumugi`, `enqueue`, `bearerAuth`, `TsumugiJobShard`, and others |
| `tsumugi/performer` | `Performer` |
| `tsumugi/client` | `createClient` and related types |
| `tsumugi/ui` | `ui()` |
| `tsumugi/types` | Types only |
| `tsumugi/testing` | `runPerformer`, `createTestContext`, `simulateFlow`, and others |

The published npm package is `tsumugi`.
Run the setup CLI with `npx tsumugi`.
For the list of commands, see [CLI](/en/reference/cli).
