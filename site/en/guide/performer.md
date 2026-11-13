---
title: Performer
description: The execution context of a Performer, which defines job processing, plus failure and retry, deployment to a separate Worker, and testing
publishedAt: 2026-07-22
updatedAt: 2026-10-25
---

<h1 id="performer">Performer</h1>

Job processing is defined as a class that extends `Performer`.

<h2 id="基本形">Basic form</h2>

```ts
import { Performer, type JobContext } from 'tsumugi/performer';

export class SendMail extends Performer<{ to: string; subject: string }, void, {}, Env> {
  async perform(payload: { to: string; subject: string }, ctx: JobContext): Promise<void> {
    const remaining = ctx.deadlineAt - Date.now();
    await fetch('https://api.example.com/mail', {
      method: 'POST',
      body: JSON.stringify(payload),
      // Abort immediately if the deadline has passed
      signal: remaining > 0 ? AbortSignal.timeout(remaining) : AbortSignal.abort(),
    });
  }
}
```

The type parameters are, in order, the payload, the return value, the required-key declaration, and `Env`.
Inside a performer, refer to the Worker's bindings through `this.env`.

<h2 id="binding名">Binding name</h2>

The binding name is the name exported from the Worker's entry point.
For `export class SendMail`, the binding name is `SendMail`, and no separate registration is needed.

```ts
// src/index.ts
export { SendMail } from './performers/send-mail.js';
```

Pass the module that collects your performers directly as `performers` to `defineTsumugi`.
The payload and required-key types for each binding are derived from this `performers`.
Make the keys of `performers` match the names exported from the Worker's entry point.

```ts
import * as performers from './performers/index.js';

export * from './performers/index.js';

const tsumugi = defineTsumugi({ performers, /* ... */ });
```

To give a binding a different name, alias it in the file that re-exports your performers.

```ts
// src/performers/index.ts
export { SendMail as MAIL } from './send-mail.js';
```

If you alias it in the Worker's entry point, the runtime binding name becomes `MAIL`.
In that case, the key in `performers` remains `SendMail`, so the two do not match.
Do not alias in the Worker's entry point.

```ts
// src/index.ts
// Only the runtime export changes; the binding name in the types no longer matches
export { SendMail as MAIL } from './performers/send-mail.js';
```

<h2 id="実行コンテキスト">Execution context</h2>

`JobContext` is passed as the second argument of `perform`.

| Field | Description |
| --- | --- |
| `jobId` | The job ID |
| `attempt` | The attempt number. 1 for the first attempt |
| `idempotencyKey` | A constant value per job. The same value on re-execution |
| `deadlineAt` | The timeout time, in epoch milliseconds |
| `heartbeat` | A function that reports that the job is running |
| `log` | An async function that saves messages during processing |
| `traceparent` | The trace information specified at enqueue time. `null` if not specified |
| `spawn` | A function that adds child nodes to the node of the running Flow |
| `fail` | A function that specifies whether a failed attempt can be retried (see "Specifying a retry" for usage) |

With `at-least-once`, assume that the same job may run more than once.
Use `idempotencyKey` to make external side effects idempotent.

<h3 id="タイムアウトによる中断">Aborting on timeout</h3>

To abort processing on timeout, create an `AbortSignal` from `deadlineAt` and pass it to the processing.
If the deadline has already passed, use `AbortSignal.abort()`.

```ts
const remaining = ctx.deadlineAt - Date.now();
const signal = remaining > 0 ? AbortSignal.timeout(remaining) : AbortSignal.abort();
```

Tsumugi does not automatically stop a performer that has passed its deadline.
A performer that does not implement abort handling with `deadlineAt` may continue to run after the deadline.

<h3 id="heartbeat">heartbeat</h3>

For processing whose duration varies greatly depending on the input, you must set `timeoutMs` to match the longest duration.
Calling `ctx.heartbeat()` moves the starting point of the timeout to the time of the last report.
Therefore, set `timeoutMs` to a value based on the reporting interval.

```ts
class Import extends Performer<{ rows: string[] }, void, {}, Env> {
  async perform(payload: { rows: string[] }, ctx: JobContext): Promise<void> {
    for (const [index, row] of payload.rows.entries()) {
      await store(row);
      await ctx.heartbeat((index + 1) / payload.rows.length);
    }
  }
}
```

The progress argument is a number from 0 to 1 inclusive.
Out-of-range values are clamped to the range, and non-numeric values are treated as a report with no progress.
The reported progress is shown in the job details on the dashboard.
A call made within 5 seconds of the previous report does not send a report.
A failed report is not raised as an exception.
The return value is `{ cancelRequested: boolean }`, which indicates whether cancellation has been requested.
Once it becomes `true`, the return values of subsequent calls are also `true`.
For details on cancellation behavior, see the [Cancellation during execution](/en/guide/execution#実行中の取り消し) section.

A single attempt must complete within 15 minutes.
Split processing that takes longer than 15 minutes into multiple jobs, or split it by adding child nodes with `ctx.spawn`.
For details, see [Timeouts and unresponsiveness](/en/guide/execution#タイムアウトと無応答).

<h3 id="ログ">Logs</h3>

`ctx.log(message)` saves a message during processing.
The call requires `await`.

```ts
await ctx.log('Import started');
await importRows(payload.rows);
await ctx.log('Import completed');
```

The dashboard shows the saved logs in the job details, together with the attempt number, the recording time, and the body.
If the performer terminates abnormally afterward, the saved logs are not deleted.
The most recent 20 logs per job are kept.
The body can be up to 2,000 characters, measured as JavaScript string length.
Any excess is truncated.
A call made within 1 second of the previous save does not save a log.
If saving fails, the error is written to `console.error` and job processing continues.

<h3 id="トレース情報">Trace information</h3>

`ctx.traceparent` is the `traceparent` value specified at enqueue time, or `null` if none was specified.
On a retry, it is the same value as at enqueue time.
When you use a tracing SDK, you must create spans with `ctx.traceparent` as the parent context.
For the format to specify at enqueue time and how to use `spawn`, see [Enqueueing jobs](/en/guide/enqueue#トレース情報) and [Flow](/en/guide/flow#perform内からのノード追加), respectively.

<h2 id="失敗とリトライ">Failure and retry</h2>

When a job fails, an exception is thrown.
If the number of attempts has not reached the limit, a retry is performed.

```ts
class ChargeCard extends Performer<{ customerId: string; amountJpy: number }, void, { concurrencyKey: true }, Env> {
  async perform(payload: { customerId: string; amountJpy: number }): Promise<void> {
    const res = await this.env.PAYMENT.charge(payload);
    if (!res.ok) throw new Error(`payment failed: ${res.status}`);
  }
}
```

The exception message is saved in the attempt history, and the dashboard shows the attempt history in the job details.
The storage limits are 2,000 characters for a message and 20 attempt history entries per job.
If the return value exceeds 8,192 characters or cannot be serialized, the return value is not saved.
For how this applies to Flow nodes, see [Flow](/en/guide/flow#制約).

<h3 id="再試行の指定">Specifying a retry</h3>

If you throw an exception after calling `ctx.fail()`, the settings passed to `ctx.fail()` apply to the follow-up retry of that attempt.
If you specify `{ retry: false }`, the job is not retried even if the number of attempts has not reached the limit, and it moves to `FAILED`.
Use this setting for failures where retrying does not change the result.

```ts
class SyncUser extends Performer<{ userId: string }, void, {}, Env> {
  async perform(payload: { userId: string }, ctx: JobContext): Promise<void> {
    const res = await fetch(`https://api.example.com/users/${payload.userId}`);
    if (res.status === 404) {
      await ctx.fail({ retry: false });
      throw new Error(`user not found: ${payload.userId}`);
    }
  }
}
```

If you specify epoch milliseconds in `{ retryAt }`, that attempt alone is retried at the specified time instead of at the interval calculated by `backoff`.
The following example converts the value of the `Retry-After` header (a number of seconds or an HTTP-date) to a time.

```ts
if (res.status === 429) {
  const header = res.headers.get('Retry-After') ?? '';
  const date = Date.parse(header);
  // If the header cannot be parsed, retry after 60 seconds
  const retryAt = /^\d+$/.test(header)
    ? Date.now() + Number(header) * 1_000
    : Number.isNaN(date)
      ? Date.now() + 60_000
      : date;
  await ctx.fail({ retryAt });
  throw new Error('rate limited');
}
```

Even when you specify `retryAt`, that attempt counts toward the number of attempts.
If `maxAttempts` has been reached, the job moves to `FAILED`.
If the specified time is later than the deadline (`expiresAt`), the job moves to `CANCELLED`.
If you specify a time in the past, the job becomes eligible for retry immediately.
The settings passed to `ctx.fail()` apply only to an attempt that ends with a throw.
If `perform` finishes without throwing, the job completes even if you called `ctx.fail()`.
If you call `ctx.fail()` more than once in a single attempt, the last specification takes effect.
If you pass a value in an invalid format to `ctx.fail()`, that call throws an exception.

<h2 id="キーの必須化">Requiring keys</h2>

For a performer whose third type parameter is `{ concurrencyKey: true }` or `{ uniqueKey: true }`, you must specify the key when enqueueing a job.

```ts
class ChargeCard extends Performer<Payload, void, { concurrencyKey: true }, Env> {}
```

You pass the key as a string when enqueueing a job.
Tsumugi does not provide a mechanism for defining a function on the performer side that derives the key.
With `tsumugi.enqueue` and `tsumugi.jobs(env)`, omitting the key causes a compile-time error.

```ts
await tsumugi.enqueue(env, { binding: 'CHARGE', payload, concurrencyKey: 'customer:c1' });
await tsumugi.jobs(env).enqueue('CHARGE', payload, { concurrencyKey: 'customer:c1' });
```

::callout{type="warning"}
Required keys are not enforced for `createClient()`.
For details, see [Enqueue methods](/en/guide/enqueue#投入方法).
::

<h2 id="別workerへの配置">Deploying to a separate Worker</h2>

Tsumugi runs a performer even when it is deployed to a separate Worker connected through a Service Binding.

```ts
// The Worker that hosts the performer
import { Performer, type JobContext } from 'tsumugi/performer';

export class SendMail extends Performer<{ to: string; subject: string }, void, {}, Env> {
  async perform(payload: { to: string; subject: string }, ctx: JobContext): Promise<void> {
    // ...
  }
}

// A default export is required in addition to the named export of the WorkerEntrypoint
export default {
  async fetch(): Promise<Response> {
    return new Response('performer only', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

In the calling Worker's wrangler.jsonc, you must configure a Service Binding that maps the binding name to the entrypoint.

```jsonc
"services": [
  { "binding": "MAIL", "service": "my-mailer", "entrypoint": "SendMail" },
],
```

In the caller's `performers`, specify `remote()` instead of the class.
A single `performers` can mix performers from the same Worker and performers from a separate Worker.

```ts
import { remote } from 'tsumugi';
import type { SendMail } from 'my-mailer';

const performers = { ...local, MAIL: remote<SendMail>() };
```

<h3 id="別workerに配置した場合の制約">Constraints when deployed to a separate Worker</h3>

For a performer deployed to a separate Worker, calls to `ctx.spawn` and `ctx.fail` require `await`.
If `perform` finishes without awaiting `ctx.spawn`, the addition of the child node is not applied.
If you throw an exception without awaiting `ctx.fail`, the specification may not be applied either.

```ts
await ctx.spawn('child', 'MAIL', payload);
```

Child nodes added with `spawn` are created after `perform` completes.
At the time `spawn` is called, the child node is not yet running.

<h2 id="テスト">Testing</h2>

`runPerformer` from `tsumugi/testing` calls a performer directly without enqueueing a job.
The `Performer` constructor takes the same two arguments as `WorkerEntrypoint`, `(ctx, env)`.

```ts
import { createTestContext, runPerformer } from 'tsumugi/testing';

declare const ctx: ExecutionContext;
declare const env: Env;

const result = await runPerformer(new SendWelcome(ctx, env), { userId: 'u_1' });

if (result.ok) console.log(result.value);
else console.error(result.error);
```

For a performer that does not use `this.env`, `runPerformer` also accepts a plain object that has `perform`.
`runPerformer` does not rethrow exceptions, and returns a result in the same format for both success and failure.
The context returned by `createTestContext()` records the settings passed to `ctx.fail()` in `fails`, in call order.

<h3 id="実行コンテキストの差し替え">Overriding the execution context</h3>

If you pass values to `createTestContext`, you can override fields of the execution context that you pass to `runPerformer`.
The following example sets the attempt number to 3.

```ts
const ctx = createTestContext({ attempt: 3 });
await runPerformer(performer, payload, ctx);
```

To verify how a performer behaves with respect to its deadline, specify a past time or a time in the near future for `deadlineAt`.

```ts
const ctx = createTestContext({ deadlineAt: Date.now() + 50 });
await runPerformer(performer, payload, ctx);
```

<h3 id="投入から実行までのテスト">Testing from enqueue to execution</h3>

To verify the whole flow from enqueueing a job to executing it, use `@cloudflare/vitest-plugin`.
`tsumugi/testing` is not intended for tests of this scope.
