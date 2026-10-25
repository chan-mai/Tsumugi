---
title: Enqueuing Jobs
description: How to enqueue jobs with enqueue, enqueueMany, and jobs, and enqueue-time options such as scheduled execution, expiration, deduplication, and serialization
publishedAt: 2026-07-22
updatedAt: 2026-10-25
---

<h1 id="ジョブの投入">Enqueuing Jobs</h1>

<h2 id="投入方法">Enqueue Methods</h2>

| Method | Type | Source of shard count and execution settings |
| --- | --- | --- |
| `tsumugi.enqueue` / `tsumugi.jobs(env)` | Payload and required-key types derived for each binding | `bindings` of `defineTsumugi` |
| `createClient(bindings)` | `binding` is `string`, `payload` is `unknown` | First argument of `createClient` |

From the same Worker as the performer, enqueue jobs using the return value of `defineTsumugi`.
`createClient` is a client for enqueuing jobs from a Worker that has no performer.

If a required binding is missing, `tsumugi.enqueue`, `tsumugi.enqueueMany`, and `tsumugi.jobs(env)` throw an exception.
The exception includes a list of the missing bindings.
`JOB_SHARD`, `TSUMUGI_DB`, and `TSUMUGI_QUEUE` are always required.
Add `RUN` if you use `flows`, and add `SCHEDULER` if you use `schedules`.
For a `remote()` performer, provide the corresponding Service Binding.

<h2 id="enqueue">enqueue</h2>

```ts
const id = await tsumugi.enqueue(env, {
  binding: 'MAIL',
  payload: { to: 'a@example.com', subject: 'hi' },
});
```

The return value is the job ID.
The type of the payload is derived from the value of the specified `binding`.
If you omit a required key, a compile error occurs.

<h2 id="enqueuemany">enqueueMany</h2>

`tsumugi.enqueueMany` enqueues multiple jobs in a batch.

```ts
const ids = await tsumugi.enqueueMany(env, [
  { binding: 'MAIL', payload: { to: 'a@example.com', subject: 'hi' } },
  { binding: 'MAIL', payload: { to: 'b@example.com', subject: 'hi' } },
]);
```

The time required barely changes as the number of jobs grows.
In the returned array, the i-th element is the ID that corresponds to the i-th job in the input.

<h2 id="jobs">jobs</h2>

The return value of `tsumugi.jobs(env)` is a typed job-enqueuing object with `env` specified in advance.

```ts
const jobs = tsumugi.jobs(env);

const id = await jobs.enqueue('MAIL', { to: 'a@example.com', subject: 'hi' });
await jobs.enqueue('CHARGE', { customerId: 'c1', amountJpy: 1200 }, { concurrencyKey: 'customer:c1' });
```

What gets enqueued is identical to `tsumugi.enqueue`.
The only difference is the form of the arguments.
For a [performer with required keys](/en/guide/performer#キーの必須化), a compile error occurs if you omit `options` or if you do not specify the key.

<h2 id="オプション">Options</h2>

| Name | Default | Description |
| --- | --- | --- |
| `priority` | `0` | Numeric priority. Larger values run first |
| `maxAttempts` | `3` | Maximum number of attempts. An integer of 1 or more |
| `backoff` | Exponential, starting at 1 second, factor 2, cap 1 hour, with jitter | Interval between retries |
| `timeoutMs` | `60000` | Time until timeout |
| `delayMs` | None | Delay before execution starts. Cannot be specified together with `runAt` |
| `runAt` | None | Time at which execution starts. Cannot be specified together with `delayMs` |
| `expiresInMs` | None | Expiration counted from the enqueue time |
| `expiresAt` | None | Expiration time. Takes precedence over `expiresInMs` |
| `guarantee` | `at-least-once` | Execution guarantee. Use `at-most-once` to avoid duplicate execution |
| `concurrencyKey` | None | Key for running jobs with the same key in order |
| `uniqueKey` | None | Key for deduplication |
| `uniqueForMs` | 24 hours | Period during which `uniqueKey` is used to detect duplicates |
| `partitionKey` | None | Key that determines the destination when shards are split |
| `traceparent` | None | W3C Trace Context of the enqueuer |

For a binding with two or more shards, omitting `partitionKey` throws an exception.
Selecting the destination shard by `partitionKey` applies only to enqueue methods that apply `shards` from `bindings`.
See [Enqueue Methods](#投入方法) for details.

<h2 id="予約実行">Scheduled Execution</h2>

```ts
// 1 hour later
await tsumugi.enqueue(env, { binding: 'MAIL', payload, delayMs: 60 * 60 * 1000 });

// At a specified time
await tsumugi.enqueue(env, { binding: 'MAIL', payload, runAt: Date.parse('2026-08-01T09:00:00+09:00') });
```

<h2 id="有効期限">Expiration</h2>

If you specify `expiresInMs` or `expiresAt`, a job past its expiration is not executed and transitions to `CANCELLED`.
Even after a pause or an execution delay, expired notifications are not executed all at once.

```ts
// Do not run if it cannot start within 5 minutes
await tsumugi.enqueue(env, { binding: 'NOTIFY', payload, expiresInMs: 5 * 60 * 1000 });
```

A running job is not interrupted even after its expiration passes.
If the next scheduled retry time is later than the expiration, the job transitions to `CANCELLED` on failure.
The expiration also applies when you manually retry `FAILED` and `STALLED` jobs.

<h2 id="重複排除">Deduplication</h2>

If you specify `uniqueKey` and a job with the same key already exists, a new job is not created.
In this case, the return value is the ID of the existing job.

```ts
const id = await tsumugi.enqueue(env, {
  binding: 'SYNC',
  payload: { sku: 'X-1' },
  uniqueKey: 'sku:X-1',
});
```

A duplicate enqueue is not an error.
No exception is thrown either.
After the `uniqueForMs` period elapses, duplicate detection is lifted.
If you enqueue again with the same key, a new job is created.

<h2 id="直列化">Serialization</h2>

Jobs with the same `concurrencyKey` run concurrently up to the number set by `perKeyConcurrency`.
The default is 1, so jobs with the same key run one at a time, in order.

```ts
await tsumugi.enqueue(env, {
  binding: 'CHARGE',
  payload: { customerId: 'c1', amountJpy: 1200 },
  concurrencyKey: 'customer:c1',
});
```

For a binding with two or more shards, this serialization is limited to within the same shard for a given `partitionKey`.
See [shard](/en/guide/execution#shard) for details.

<h2 id="トレース情報">Trace Information</h2>

If you specify `traceparent` when enqueuing, the same value is passed to `ctx.traceparent` in the performer.
The same value is passed on retries, and the dashboard shows this value in the job details.
`enqueueMany` accepts a `traceparent` for each job.

```ts
await tsumugi.enqueue(env, {
  binding: 'MAIL',
  payload: { to: 'a@example.com', subject: 'hi' },
  traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
});
```

The format is W3C Trace Context version `00` (55 characters).
Write each field in lowercase hexadecimal.
If you specify a malformed value, a validation error occurs at enqueue time.
A validation error also occurs if every digit of the trace-id or the parent-id is 0.

<h2 id="ジョブid">Job ID</h2>

```
<binding>#<shard>:<localId>
```

Example: `MAIL#0:xxxxxxxxxxxxxxxxxxxxxxxx`

Even if you change the number of shards, existing job IDs still identify the same jobs.
However, the destination shard of jobs with the same `partitionKey` value may differ before and after the change.
Control by `concurrencyKey` and `uniqueKey` is performed per shard, so it does not apply between jobs whose destination shards differ.
If you reduce the number of shards, [runtime configuration changes](/en/guide/execution#実行時の変更) are not applied to the shards that fall out of range.
For details on shards, see [shard](/en/guide/execution#shard).

<h2 id="別workerからの投入">Enqueuing from Another Worker</h2>

For enqueuing from a Worker that has no performer, see [Enqueuing from Another Worker](/en/guide/client).
