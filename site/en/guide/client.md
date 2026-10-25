---
title: Enqueueing from Another Worker
description: How to enqueue jobs from a Worker that has no performer, using createClient from tsumugi/client
publishedAt: 2026-07-22
updatedAt: 2026-10-25
---

<h1 id="別workerからの投入">Enqueueing from Another Worker</h1>

To enqueue jobs from a Worker that has no performer, use `createClient` from `tsumugi/client`.
In a Worker that defines performers, enqueue through the return value of `defineTsumugi`.

<h2 id="使い方">Usage</h2>

```ts
import { createClient } from 'tsumugi/client';

const jobs = createClient<Env>();

export default {
  async fetch(request, env) {
    const id = await jobs.enqueue(env, {
      binding: 'MAIL',
      payload: { to: 'a@example.com', subject: 'hi' },
    });
    return Response.json({ id });
  },
} satisfies ExportedHandler<Env>;
```

<h2 id="必要なbinding">Required binding</h2>

The only binding you need to configure on the enqueueing Worker is `JOB_SHARD`.
Set `script_name` to the name of the Worker where Tsumugi is configured.

```jsonc
{
  "durable_objects": {
    "bindings": [
      {
        "name": "JOB_SHARD",
        "class_name": "TsumugiJobShard",
        "script_name": "my-jobs",
      },
    ],
  },
}
```

<h2 id="設定の一致">Matching the configuration</h2>

For a binding with `shards` set to 2 or more, pass the same `shards` value to `createClient`.

```ts
const jobs = createClient<Env>({
  MAIL: { shards: 4 },
});
```

For each binding, set `policy` and the retention period to the same values as in the Worker where Tsumugi is configured.

<h2 id="投入時の既定値">Defaults at enqueue time</h2>

The `onEnqueue` function passed to `defineTsumugi` does not apply to jobs enqueued from another Worker.
To use the same defaults for jobs enqueued from another Worker, pass the same function as the third argument of `createClient`.

```ts
const jobs = createClient<Env>(
  {},
  {},
  { onEnqueue: (input) => (input.binding === 'MAIL' ? { timeoutMs: 120_000 } : undefined) },
);
```

How defaults are resolved is explained in [Defaults at enqueue time](/en/guide/execution#投入時の既定値).

<h2 id="api">API</h2>

| Method | Description |
| --- | --- |
| `enqueue(env, input)` | Enqueues one job. Returns the job ID |
| `enqueueMany(env, inputs)` | Enqueues multiple jobs in one call |
| `shardFor(env, binding, partitionKey?)` | Gets the stub of the shard that receives the job |

<h2 id="型">Types</h2>

`tsumugi/client` provides types such as `EnqueueInput`, `EnqueueOptions`, `EnqueueItem`, `JobQueue`, `Performers`, `BindingConfig`, and `TsumugiClient`.

In the `EnqueueInput` that `enqueue` of `createClient` accepts, `binding` is of type `string` and `payload` is of type `unknown`.
As a result, per-binding type checking and required keys do not apply.
If you share the performer types, you can write a wrapper that conforms to `JobQueue<M>`, which gives you the same type checking as `defineTsumugi`.
The differences between the two are summarized in [Enqueue methods](/en/guide/enqueue#投入方法).

<h2 id="rest-apiからの投入">Enqueueing from the REST API</h2>

To enqueue jobs without adding a Worker, send a request to the REST API of the Worker where Tsumugi is configured.

```bash
curl -X POST https://my-jobs.example.workers.dev/api/jobs \
  -H "Authorization: Bearer $TSUMUGI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"binding":"MAIL","payload":{"to":"a@example.com","subject":"hi"}}'
```

For the request format, see [REST API](/en/reference/rest-api#post-apijobs).
