---
title: Execution Control
description: Job states and transitions, retries and backoff, execution guarantees, timeouts, execution limits, retention periods, and failure and termination notifications
publishedAt: 2026-07-22
updatedAt: 2026-10-25
---

<h1 id="実行の制御">Execution Control</h1>

<h2 id="状態">States</h2>

| State | Meaning |
| --- | --- |
| `SCHEDULED` | Waiting for the first execution or a retry |
| `QUEUED` | Eligible to run, before the performer starts |
| `RUNNING` | The performer is running |
| `COMPLETED` | Succeeded. One of the terminal states; no transitions to other states |
| `FAILED` | Failed up to the attempt limit. Transitions to `SCHEDULED` on a manual retry |
| `CANCELLED` | Cancelled. One of the terminal states; no transitions to other states |
| `STALLED` | Stopped without a result being reported. Transitions to `SCHEDULED` only on a manual retry |

`attempts` is the number of finished attempts.
A `SCHEDULED` job is waiting for its first execution if `attempts` is 0, and waiting for a retry if it is 1 or more.
Retry `FAILED` and `STALLED` jobs manually from the dashboard or the REST API.

<h3 id="遷移">Transitions</h3>

Cancelling a `SCHEDULED` job immediately moves it to `CANCELLED`.
A `QUEUED` or `RUNNING` job moves to `CANCELLED` when its deadline passes or when [cancellation during execution](#実行中の取り消し) is confirmed.

<h2 id="リトライ">Retries</h2>

The upper limit on retries is set with `maxAttempts`, and the interval is set with `backoff`.
Specify an integer of 1 or more for `maxAttempts`.
Specify `backoff` in one of two forms: `fixed` for a fixed interval, or `exponential` for exponential backoff.

::callout{type="info"}
`max_retries` in wrangler.jsonc is a Queues setting. It does not affect Tsumugi retries.
::

<h3 id="バックオフ">Backoff</h3>

The default is the following exponential backoff.

```ts
{ kind: 'exponential', baseMs: 1_000, factor: 2, maxMs: 3_600_000, jitter: true }
```

To use a fixed interval, specify `fixed` for `kind`.

```ts
await tsumugi.enqueue(env, {
  binding: 'MAIL',
  payload,
  backoff: { kind: 'fixed', delayMs: 30_000, jitter: true },
});
```

Specifying `jitter: true` spreads out the retry times of many jobs that failed at the same time.
To specify from the performer whether to retry and when the next retry runs, see [Specifying retries](/en/guide/performer#再試行の指定).

<h2 id="実行保証">Execution Guarantees</h2>

`guarantee` is either `at-least-once` (default) or `at-most-once`.
The behavior for a job whose result is not reported depends on the value you choose.

| Guarantee | Behavior when no result is reported |
| --- | --- |
| `at-least-once` (default) | Re-enqueued as `SCHEDULED` |
| `at-most-once` | `STALLED` without re-enqueue. Re-execution is limited to manual retries |

```ts
await tsumugi.enqueue(env, {
  binding: 'CHARGE',
  payload,
  guarantee: 'at-most-once',
});
```

An `at-most-once` job is never executed twice.
In exchange, the time until execution starts is longer than with `at-least-once`.

<h2 id="タイムアウトと無応答">Timeouts and Unresponsiveness</h2>

An attempt that exceeds `timeoutMs` is treated as a failure.
`TsumugiTimeoutError` (`job timed out (<jobId>, <timeoutMs>ms)`) is recorded as the attempt's error.
The performer's execution is not stopped after the timeout.
Therefore, an `at-most-once` job moves to `STALLED` on timeout and is not retried even if attempts remain.
To abort processing, see [Aborting on timeout](/en/guide/performer#タイムアウトによる中断).

A single invocation of a Cloudflare Queues consumer is limited to 15 minutes of execution time (wall time).
Therefore, Tsumugi fails an attempt as timed out once 14 minutes have passed since the consumer invocation started, even before `timeoutMs` elapses.
`job exceeded the consumer wall time limit (<jobId>, 900000ms)` is recorded as the attempt's error.
Handling after the failure is the same as for a timeout by `timeoutMs`.
A retry is made if attempts remain, but an `at-most-once` job moves to `STALLED` and is not retried.
Also, `ctx.deadlineAt` is never later than this deadline.

A `RUNNING` job is judged unresponsive if no attempt result is recorded after `timeoutMs` and `reaperGraceMs` (default 30 seconds) have passed since execution started (or since the last `heartbeat`).
A `QUEUED` job is judged unresponsive if execution has not started after the sum of `queueWaitMs` (default 15 minutes), `timeoutMs`, and `reaperGraceMs` has passed since the job was sent to Queues.
If a `heartbeat` has been recorded for a `QUEUED` job, it is judged unresponsive when `timeoutMs` and `reaperGraceMs` have passed since the last `heartbeat`.
`queueWaitMs` is the time allowed so that a job whose execution has not started while its message waits in Queues is not judged unresponsive.
Increasing `queueWaitMs` lengthens the time until a job is re-enqueued when a Queues message is lost.
An `at-most-once` job moves to `STALLED` regardless of the number of attempts.
An `at-least-once` job is re-enqueued if it has not reached the attempt limit, and moves to `FAILED` if it has.

<h2 id="実行中の取り消し">Cancellation During Execution</h2>

Cancelling a `QUEUED` or `RUNNING` job records a cancellation request to the performer.
Run the cancellation from the dashboard or with [`POST /api/jobs/:id/cancel`](/en/reference/rest-api#post-apijobsidcancel).
The response of this endpoint includes `requested: true`.

The performer checks for the request through `cancelRequested`, the return value of `ctx.heartbeat()`.
To abort processing, throw an exception and exit.
An attempt that fails after the request is not retried, and the job moves to `CANCELLED`.

```ts
const { cancelRequested } = await ctx.heartbeat(progress);
if (cancelRequested) throw new Error('cancelled');
```

If success is reported before the request, the job stays `COMPLETED` and its result is also saved.
If no result is reported by the time `reaperGraceMs` (default 30 seconds) has passed since the request, the job moves to `CANCELLED`.
The performer's execution is not stopped, so a performer that does not check for the request keeps running.
Reports made after the job moves to `CANCELLED` are discarded.

A job waiting for a retry moves to `CANCELLED` without being re-enqueued.
An `at-most-once` job that has not yet run also moves to `CANCELLED` without being executed.
If you request `reschedule` for a job that already has a cancellation requested, the REST API responds with 409.
A performer that does not call `heartbeat` does not check for the request.

<h2 id="実行量の制限">Execution Limits</h2>

Execution volume is limited per binding with four settings.

| Setting | Default | Description |
| --- | --- | --- |
| `concurrency` | `100` | Upper limit on the number of jobs running at the same time |
| `rate` | `null` | Upper limit on the number of jobs executed per time period. `null` means no limit |
| `perKeyConcurrency` | `1` | Upper limit on concurrent executions per `concurrencyKey` |
| `perKeyRate` | `null` | Upper limit on executions per time period for each `concurrencyKey`. `null` means no limit |

```ts
const tsumugi = defineTsumugi({
  performers,
  bindings: {
    MAIL: {
      policy: {
        concurrency: 20,
        rate: { tokens: 100, intervalMs: 60_000 },
        perKeyConcurrency: 1,
        perKeyRate: { tokens: 10, intervalMs: 60_000 },
      },
    },
  },
});
```

`perKeyRate` applies the same value to all keys.
There is no setting that uses a different value for each key.
`perKeyConcurrency` and `perKeyRate` do not apply to jobs whose `concurrencyKey` is null.

<h3 id="実行されない原因の確認">Checking Why a Job Is Not Executed</h3>

If an enqueued job is not executed, check the response of [`GET /api/diagnostics`](/en/reference/rest-api#get-apidiagnostics) to see which setting is limiting execution.
The response indicates whether the cause is a pause, the concurrency limit, or the rate limit.

<h3 id="実行時の変更">Changing Settings at Runtime</h3>

In the `bindings` tab of the dashboard, you can change the concurrency and pause enqueuing.
Changes require no deployment and apply to all shards of the binding.
This operation is equivalent to calling [`POST /api/bindings/:binding/policy`](/en/reference/rest-api#post-apibindingsbindingpolicy).

```bash
curl -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"paused": true}' https://example.com/api/bindings/MAIL/policy
```

After resuming, lower-priority jobs that were waiting before the pause may run before higher-priority jobs that were enqueued later.

![bindings tab](/dashboard-bindings.jpg)

To change settings from code, call `configure` on the stub obtained with `tsumugi.shardFor`.
`configure` changes the execution volume settings with `policy`, and the retention periods with `sweepAfterMs` and `failedRetentionMs`.

```ts
await tsumugi.shardFor(env, 'MAIL').configure({ policy: { concurrency: 5 } });
```

For a binding with 2 or more shards, the stub obtained with `shardFor` is the stub for the single shard chosen by `partitionKey`.
A change made with `configure` applies only to that shard.
To apply a change to all shards, use the dashboard or [`POST /api/bindings/:binding/policy`](/en/reference/rest-api#post-apibindingsbindingpolicy).

Settings changed at runtime take precedence over the `bindings` settings.
After that, the `bindings` settings are no longer applied.
To return to the `bindings` settings, call [`POST /api/bindings/:binding/policy/reset`](/en/reference/rest-api#post-apibindingsbindingpolicyreset).
Alternatively, specify the original values again with `configure`.

<h2 id="エージング">Aging</h2>

If higher-priority jobs keep being enqueued, lower-priority jobs are never executed.
To prevent this, the effective priority rises according to waiting time.
This behavior is called aging and is applied by default.
The interval at which the priority rises is `agingIntervalMs`, which defaults to 60 seconds.
If you specify `null`, aging is not applied and jobs run in priority order.

<h2 id="shard">shard</h2>

A shard is a unit into which a binding's jobs are divided and managed.
The default number of shards is 1.

```ts
bindings: {
  MAIL: { shards: 4 },
}
```

If the number of shards is 2 or more, `partitionKey` is required, and omitting it raises an exception.
The scope of control by `concurrencyKey` and `uniqueKey` depends on the number of shards.
If there is 1 shard, all jobs in the binding are covered.
If there are 2 or more, control is limited to jobs in the same shard chosen by `partitionKey`.

`concurrency` and `rate` in [Execution Limits](#実行量の制限) also apply per shard.
The upper limit on the number of jobs running at the same time across the whole binding is the `concurrency` value multiplied by the number of shards.
The upper limit of `rate` is the `rate` value multiplied by the number of shards.

When you use `concurrencyKey` or `uniqueKey`, specify the same key for `partitionKey` as well.
Setting different values does not cause an error, but jobs with the same key may be assigned to different shards.
As a result, concurrent execution or duplicate creation may occur.

<h2 id="保持期間">Retention Periods</h2>

Finished jobs are deleted after a certain period.

| Target | Setting | Default |
| --- | --- | --- |
| `COMPLETED` / `CANCELLED` | `sweepAfterMs` | 5 minutes |
| `FAILED` / `STALLED` | `failedRetentionMs` | 7 days |

Deleted jobs cannot be retried.
Both settings are specified per binding in `bindings`.

```ts
const tsumugi = defineTsumugi({
  performers,
  bindings: {
    MAIL: { sweepAfterMs: 60 * 60 * 1000, failedRetentionMs: 14 * 24 * 60 * 60 * 1000 },
  },
});
```

The period for which jobs appear in the dashboard and REST API lists is set with `retention`, separately from the retention periods above.
When a cron trigger is configured, finished jobs and Runs older than that period are removed from the lists.
For details, see [SweepOptions](/en/reference/config#sweepoptions).

By default, the two periods match.
Therefore, `FAILED` and `STALLED` jobs shown in the list can be retried.
If you change only one of the periods, the REST API may respond with 410 to a retry request even for a job shown in the list.

<h2 id="失敗の通知">Failure Notifications</h2>

If you specify the name of the notification target binding in `onFailure`, `FAILED` and `STALLED` jobs are notified to the specified performer.
`FAILED` is a job that failed up to the attempt limit.
`STALLED` is a job that stopped without a result being reported.

```ts
const tsumugi = defineTsumugi({
  performers,
  onFailure: 'NotifyFailure',
});
```

The notification target performer receives a `FailureNotice` as its argument.

```ts
import { Performer } from 'tsumugi/performer';
import type { FailureNotice } from 'tsumugi';

export class NotifyFailure extends Performer<FailureNotice, void, {}, Env> {
  async perform(notice: FailureNotice): Promise<void> {
    const res = await fetch(this.env.SLACK_WEBHOOK, {
      method: 'POST',
      body: JSON.stringify({ text: `${notice.binding} が失敗しました: ${notice.error}` }),
    });
    if (!res.ok) throw new Error(`notification failed: ${res.status}`);
  }
}
```

<h3 id="failurenotice">FailureNotice</h3>

| Name | Description |
| --- | --- |
| `jobId` | ID of the failed job |
| `binding` | binding of the failed job |
| `state` | `FAILED` or `STALLED` |
| `attempts` | Number of executions |
| `maxAttempts` | Upper limit on attempts |
| `error` | Error of the last attempt. `null` if none is recorded |
| `runId` | Run that enqueued the job. `null` for a job enqueued on its own |
| `nodeId` | node that enqueued the job. `null` for a job enqueued on its own |
| `failedAt` | Time of failure, in epoch milliseconds |

Jobs of all bindings are covered by notifications.
Each notification is executed as one job.
If a notification job fails, that job appears in the list.
A notification job is also subject to retries, like other jobs.
Failures of jobs of the notification target binding itself are not notified.
Jobs that failed before `onFailure` was specified are not covered.

<h2 id="終了の通知">Termination Notifications</h2>

If you specify `onSettled`, finished jobs, not only failed ones, are notified to the specified performer.
Specify the states to notify in `states`, choosing from `COMPLETED`, `FAILED`, `CANCELLED`, and `STALLED`.
`states` is required.
Specifying an empty array or an invalid state raises an exception in `defineTsumugi`.

```ts
const tsumugi = defineTsumugi({
  performers,
  onSettled: {
    binding: 'NotifySettled',
    states: ['COMPLETED', 'FAILED', 'CANCELLED', 'STALLED'],
  },
});
```

If you include `COMPLETED`, as many notification jobs are enqueued as there are completed jobs.
Check the job volume before specifying it.
The notification target performer receives a `SettledNotice` as its argument.

<h3 id="settlednotice">SettledNotice</h3>

| Name | Description |
| --- | --- |
| `jobId` | ID of the finished job |
| `binding` | binding of the finished job |
| `state` | State at termination |
| `attempts` | Number of executions |
| `maxAttempts` | Upper limit on attempts |
| `error` | Error of the last attempt. `null` for terminations other than failure, and if none is recorded |
| `result` | Return value of `perform`. `null` for states other than `COMPLETED`, and if it exceeds the storage limit |
| `runId` | Run that enqueued the job. `null` for a job enqueued on its own |
| `nodeId` | node that enqueued the job. `null` for a job enqueued on its own |
| `settledAt` | Time of termination, in epoch milliseconds |

Jobs of the notification target binding itself and jobs of the `onFailure` notification target binding are not notified.
If you specify it together with `onFailure`, `FAILED` and `STALLED` jobs included in `states` are notified to both targets.
Jobs that finished before `onSettled` was specified are not covered.

<h2 id="投入時の既定値">Defaults at Enqueue</h2>

If you specify `onEnqueue`, it is called each time a job is enqueued, and its return value is used as the default execution options.
Values specified by the caller always take precedence, and the defaults apply only when an option is not explicitly specified.

```ts
const tsumugi = defineTsumugi({
  performers,
  onEnqueue: (input) => (input.binding === 'SlowJob' ? { timeoutMs: 300_000 } : undefined),
});
```

The execution options that can have defaults are `traceparent`, `priority`, `maxAttempts`, `backoff`, `timeoutMs`, `guarantee`, `delayMs`, `runAt`, `expiresAt`, `expiresInMs`, and `concurrencyKey`.
`binding`, `payload`, `uniqueKey`, `uniqueForMs`, and `partitionKey` are not covered.

`onEnqueue` is not applied to the notification jobs of `onFailure` and `onSettled`.
To also apply it to jobs enqueued from another Worker, pass the same function to [`createClient`](/en/guide/client#投入時の既定値).
