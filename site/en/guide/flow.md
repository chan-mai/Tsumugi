---
title: Flow
description: Defining Flows, which describe multiple dependent jobs as a directed acyclic graph (DAG), plus fan-out, conditional branching, and failure behavior
publishedAt: 2026-07-22
updatedAt: 2026-10-25
---

<h1 id="flow">Flow</h1>

A Flow defines multiple dependent jobs as a directed acyclic graph (DAG).
A Run is a single execution of a Flow.

<h2 id="定義">Definition</h2>

`createFlow` takes `performers` and returns a function that defines a Flow.
Binding names and payload types are type-checked in the same way as for standalone jobs.

```ts
import { createFlow, defineTsumugi } from 'tsumugi';

const performers = { ListNames, Greet, Report };
const flow = createFlow(performers);

const flows = {
  GREETINGS: flow<{ prefix: string }>((f) => {
    const list = f.node('list', 'ListNames', {
      input: (i) => ({ prefix: i.prefix }),
    });

    const each = f.fanOut('greet', 'Greet', {
      after: { list },
      over: (_i, d) => d.list.names,
      input: (name) => ({ name }),
    });

    f.node('report', 'Report', {
      after: { each },
      input: (_i, d) => ({ total: d.each.total, failed: d.each.failed }),
    });
  }),
};

const tsumugi = defineTsumugi({ performers, flows, auth: /* ... */ });
```

The first argument of `f.node` is the node ID, and the second is the binding name.
The binding name must match the [exported name](/en/guide/performer#binding名).
A node ID consists of alphanumeric characters, hyphens, and underscores.

`input` is a function that generates the payload from the Flow input and the return values of upstream nodes.
Its second argument is an object whose property names are the keys of the object passed to `after`.
In a node definition, you can optionally specify the same options as when enqueuing a job (such as `maxAttempts`, `backoff`, `timeoutMs`, `priority`, and `concurrencyKey`).

<h2 id="開始">Starting a Run</h2>

```ts
const runId = await tsumugi.start(env, 'GREETINGS', { prefix: 'hello' });
```

The type of `input` is derived from the type argument of the Flow.
If you pass `{ id }` as the fourth argument of `start`, the runId is fixed to `<flow>:<id>`.
If you start a Flow a second time with the same ID, no new Run is created and the existing runId is returned.
Calling `start` from an HTTP handler that is retried therefore does not create duplicate Runs.
`{ deadlineMs }` in the fourth argument sets the [deadline](#期限) for the entire Run.

<h2 id="fan-out">fan-out</h2>

Use `f.fanOut` to define parallel processing based on the number of elements in an array.
One child node is created for each element of the value returned by `over`.
The ID of a child node is the element's index. For example, `greet:0` and `greet:1`.
If you pass `key`, the value returned by `key` is used instead of the index.
The allowed characters are the same as for node IDs.

Downstream nodes receive an aggregate in the following format.

```ts
{ total: 3, succeeded: 2, failed: 1 }
```

The return value of each child node is not passed to downstream nodes.
If you need individual results, have the performer write them to R2, D1, or a similar store, and return a reference to them.
If a child node fails, the fan-out node itself does not fail.
To detect failures, check the `failed` value that downstream nodes receive.

<h2 id="perform内からのノード追加">Adding nodes from within perform</h2>

Calling `ctx.spawn` adds a child node to the running node.

```ts
class Crawl extends Performer<{ url: string }, void, {}, Env> {
  async perform(payload: { url: string }, ctx: JobContext): Promise<void> {
    for (const found of await this.discover(payload.url)) {
      ctx.spawn(found.id, 'CRAWL', { url: found.url });
    }
  }
}
```

The ID in the first argument is required.
The ID of a child node is composed as `<parent node ID>:<specified ID>`, and the allowed characters are the same as for node IDs.
Calling `spawn` multiple times with the same ID does not create duplicate child nodes.
Child nodes added during an attempt in which `perform` failed are not created.
Add them again in the `perform` of the retry.

Type checking does not apply to `spawn`.
The binding name and payload are passed as runtime values.
When calling it from a performer in a different Worker, [`await` is required](/en/guide/performer#別workerに配置した場合の制約).

<h2 id="subflow">subflow</h2>

`f.subflow` starts another Flow as a Run.
The node completes when that Run finishes.

```ts
const REPORTING = flow<{ ids: string[] }>((f) => {
  // ...
});

const PIPELINE = flow<{ prefix: string }>((f) => {
  const list = f.node('list', 'LIST', { input: (i) => ({ prefix: i.prefix }) });
  const reported = f.subflow('report', REPORTING, { input: (_i, d) => ({ ids: d.list.ids }) });
  f.node('notify', 'NOTIFY', { after: { reported }, input: () => ({}) });
});
```

Pass the Flow definition itself as the second argument.
The type of `input` is derived from the type argument of the Flow you pass.
Register the Flow to be started in `flows`.
If it is not registered, an error occurs at start time.

The runId of the child Run is `<child Flow name>:<local part of the parent runId>-<node ID>`.
The state of the child Run is reflected as-is as the state of the node.
The state is one of `COMPLETED`, `FAILED`, or `CANCELLED`.
Cancelling the parent Run also cancels the child Run.

The parent node does not receive a return value from the child Run.
If you need the result, have the performer write it to R2, D1, or a similar store.
For the nesting limit, see [Limits](#制約).

<h2 id="待ち合わせ">Synchronization</h2>

A node completes when the node itself and all of its descendant nodes have finished.
Downstream nodes that depend on a node specified in `after` run after the fan-out child nodes and the descendant nodes added by `spawn` have finished.

<h2 id="実行条件">Execution conditions</h2>

By default, a node runs only when all the nodes it depends on have succeeded.
`trigger` specifies the behavior when a node it depends on fails.

| Value | Condition under which the node runs |
| --- | --- |
| `'success'` | All dependencies succeeded. Default |
| `'failure'` | At least one dependency is `FAILED`, `STALLED`, or `CANCELLED` |
| `'always'` | All dependencies have finished, regardless of success or failure |

```ts
const flows = {
  BACKUP: flow<{ target: string }>((f) => {
    const dump = f.node('dump', 'DUMP', { input: (i) => ({ target: i.target }) });

    // Runs only on failure
    f.node('alert', 'ALERT', {
      after: { dump },
      trigger: 'failure',
      input: (i) => ({ message: `backup failed: ${i.target}` }),
    });

    // Runs regardless of success or failure
    f.node('unlock', 'UNLOCK', { after: { dump }, trigger: 'always', input: (i) => ({ target: i.target }) });
  }),
};
```

Specifying `trigger` on a node without `after` causes an error.
Only nodes that actually failed count toward the `'failure'` condition.
A node that became `SKIPPED` because its `trigger` or `when` condition was not met does not count as a failure.
If all the nodes it depends on are `SKIPPED`, a `'failure'` node does not run.

With `'failure'` and `'always'`, a failed node has no return value.
The type of the second argument of `input` includes `undefined`, so write code that handles the case where there is no value.

```ts
f.node('alert', 'ALERT', {
  after: { dump },
  trigger: 'always',
  // d.dump may be undefined
  input: (_i, d) => ({ size: d.dump?.size ?? 0 }),
});
```

<h2 id="条件分岐">Conditional branching</h2>

`when` determines whether a node runs, based on the Flow input and the results of upstream nodes.
If `when` returns `false`, the node transitions to `SKIPPED`, and downstream nodes that depend on it do not run either.
If an exception occurs inside `when`, the node transitions to `FAILED`.

```ts
f.node('detail', 'DETAIL', {
  after: { list },
  when: (i, d) => i.verbose && d.list.items.length > 0,
  input: (_i, d) => ({ items: d.list.items }),
});
```

When evaluating `when` and `input`, use only the values of the arguments and do not make any external calls.

<h2 id="失敗時の動作">Behavior on failure</h2>

When a node fails, downstream nodes that depend on it with `'success'` transition to `SKIPPED`.
Downstream nodes whose `trigger` is `'failure'` or `'always'` run.
Nodes that do not depend on the failed node run to the end.
When all nodes have finished, the Run transitions to `FAILED`.

A Run becomes `FAILED` only when there is a failed node.
Nodes that did not run because of a `trigger` or `when` condition do not count as failures.
Even if a `trigger: 'failure'` node succeeds, the Run ends as `FAILED` if an upstream node failed.
The reason a node became `SKIPPED` is recorded in the node's `error` and shown in the Run details on the dashboard.

Resume a `FAILED` Run from the dashboard or the REST API.
The results of nodes that succeeded are reused as they are, and all other nodes are treated as not yet run and are executed again.

<h2 id="取り消し">Cancellation</h2>

When you cancel a Run, nodes that have not yet run are not started.
A [cancellation request](/en/guide/execution#実行中の取り消し) is sent to running nodes.
Running jobs are not stopped.
The Run transitions to `CANCELLED` when the performer checks the request and finishes, or when no result has been reported after `reaperGraceMs` (default 30 seconds) has passed since the request.

<h2 id="期限">Deadline</h2>

Specify the deadline for the entire Run in the second argument of the Flow definition.

```ts
const GREETINGS = flow<{ prefix: string }>(
  (f) => {
    // ...
  },
  { deadlineMs: 10 * 60 * 1000 },
);
```

Specify `deadlineMs` as a positive integer (milliseconds).
If you pass `{ deadlineMs }` in the fourth argument of `start`, that value takes precedence.

A Run that passes its deadline is aborted by the same procedure as cancellation.
Nodes that have not yet run transition to `FAILED` with the error `run deadline exceeded`.
Running jobs are not stopped, and the Run transitions to `FAILED` when those jobs finish.
Running child Runs are cancelled.

A Run that does not finish by its deadline transitions to `FAILED` even if all remaining nodes succeed.
Such a Run can be resumed, just like a Run that failed in the usual way.
When you resume it, the deadline is measured anew from the time of resumption.

<h2 id="保持期間">Retention period</h2>

A finished Run is deleted after `runs.sweepAfterMs` (default 5 minutes) has elapsed.
A `FAILED` Run is deleted after `runs.failedRetentionMs` (default 7 days) has elapsed.
For details, see [RunSettings](/en/reference/config#runsettings).

<h2 id="デプロイと実行中のrun">Deployment and running Runs</h2>

A running Run continues with the node configuration it had when it started.
If you change functions such as `input`, the change takes effect starting with the next node that starts.

If you remove a node from the definition, any running Run that contains that node fails at that node.
When removing a node, deploy after all running Runs have finished.

<h2 id="テスト">Testing</h2>

`simulateFlow` verifies the execution order of nodes and the payload passed to each node for a given input.
The actual processing of the performers is not executed.

```ts
import { simulateFlow } from 'tsumugi/testing';

const result = simulateFlow(flows.GREETINGS, { prefix: 'hello' }, { results: { list: { names: ['a', 'b'] } } });

expect(result.nodes.map((node) => node.id)).toEqual(['list', 'greet:0', 'greet:1', 'greet', 'report']);
expect(result.nodes[1].payload).toEqual({ name: 'a' });
```

Pass the return value of each node in `results`, keyed by node ID.
A value can be either the return value itself or a function that produces it.
The return value of a node you do not pass is `undefined`.
A node you pass in `fails` fails, and downstream nodes transition to `SKIPPED`.
The Run transitions to `FAILED`.
Fan-out child nodes are created from the value returned by `over`, but child nodes added by `ctx.spawn` are not included.

<h2 id="制約">Limits</h2>

`uniqueKey` cannot be used with nodes.
Specifying a performer that requires `uniqueKey` as a node causes a type error.

If the return value of a node exceeds 8,192 characters or cannot be serialized, the attempt is treated as a failure.
After a failure, retries are made up to `maxAttempts`.
Write large results to R2 or a similar store, and return a reference to them.

The number of nodes a single Run can contain is 10,000 by default.
The nesting depth of subflows is 3 levels by default.
Change these limits with `runs.maxNodes` and `runs.maxDepth` in `defineTsumugi`.

<h2 id="設定">Configuration</h2>

If you specify `flows`, add the following two entries to your wrangler configuration.
If you do not specify `flows`, these settings are not needed.

```jsonc
{
  "durable_objects": {
    "bindings": [
      { "name": "JOB_SHARD", "class_name": "TsumugiJobShard" },
      { "name": "RUN", "class_name": "TsumugiRun" },
    ],
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["TsumugiJobShard"] },
    { "tag": "v2", "new_sqlite_classes": ["TsumugiRun"] },
  ],
}
```

Export `TsumugiRun` by extending the `runClass` included in the return value of `defineTsumugi`.
The D1 migrations must be applied again.

```ts
export { TsumugiJobShard } from 'tsumugi';
export class TsumugiRun extends tsumugi.runClass {}
```

```bash
pnpm wrangler d1 migrations apply my-jobs --remote
```
