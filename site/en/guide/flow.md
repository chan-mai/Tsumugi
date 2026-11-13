---
title: Flow
description: Defining a Flow, which describes multiple jobs with dependencies as a directed acyclic graph (DAG), plus fan-out, conditional branching, and behavior on failure
publishedAt: 2026-07-22
updatedAt: 2026-10-25
---

<h1 id="flow">Flow</h1>

A Flow defines multiple jobs with dependencies as a directed acyclic graph (DAG).
A Run is a single execution of a Flow.

<h2 id="定義">Definition</h2>

`createFlow` takes `performers` and returns a function that defines a Flow.
Binding names and payload types are type-checked in the same way as for a standalone job.

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

`input` is a function that generates the payload from the Flow input and the return values of preceding nodes.
Its second argument is an object whose property names are the keys of the object passed to `after`.
If the generated payload exceeds the [limit](/en/guide/enqueue#enqueue), the node becomes `FAILED`.
A node definition can optionally take the same options as when enqueuing a job (`maxAttempts`, `backoff`, `timeoutMs`, `priority`, `concurrencyKey`, and so on).

<h2 id="開始">Starting a Run</h2>

```ts
const runId = await tsumugi.start(env, 'GREETINGS', { prefix: 'hello' });
```

The type of `input` is derived from the type argument of the Flow.
If you pass `{ id }` as the fourth argument of `start`, the runId is fixed to `<flow>:<id>`.
If you start a Run with the same ID a second time, no new Run is created and the existing runId is returned.
Calling `start` from an HTTP handler that is retried therefore does not create duplicate Runs.
`{ deadlineMs }` in the fourth argument sets the [deadline](#期限) for the whole Run.

<h2 id="fan-out">fan-out</h2>

Use `f.fanOut` to define parallel processing based on the number of elements in an array.
One child node is created for each element of the return value of `over`.
The ID of a child node is the element's index. For example, `greet:0` and `greet:1`.
If you pass `key`, the return value of `key` is used instead of the index.
The allowed characters are the same as for node IDs.

Subsequent nodes receive an aggregate value in the following form.

```ts
{ total: 3, succeeded: 2, failed: 1 }
```

The return value of each child node is not passed to subsequent nodes.
If you need individual results, have the performer write them to R2, D1, or a similar store, and return a reference to them.
Even if a child node fails, the fan-out node itself does not fail.
To find out whether any child failed, check the `failed` value that subsequent nodes receive.

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
A child node's ID is formed as `<parent node ID>:<specified ID>`, and the allowed characters are the same as for node IDs.
Calling `spawn` multiple times with the same ID does not create duplicate child nodes.
Child nodes added during an attempt in which `perform` fails are not created.
Add them again when `perform` runs on the retry.

Type checking does not apply to `spawn`.
Pass the binding name and payload as runtime values.
When calling it from a performer in a different Worker, [`await` is required](/en/guide/performer#別workerに配置した場合の制約).

<h2 id="subflow">subflow</h2>

`f.subflow` starts another Flow as a Run.
The node completes when that Run ends.

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
The state of the child Run is reflected directly as the state of the node.
The state is one of `COMPLETED`, `FAILED`, or `CANCELLED`.
Cancelling the parent Run also cancels the child Run.

The parent node does not receive the return value of the child Run.
If you need the result, have the performer write it to R2, D1, or a similar store.
For the nesting limit, see [Limits](#制約).

<h2 id="待ち合わせ">Joining</h2>

A node completes when it and all of its descendant nodes have ended.
A subsequent node that depends on a node specified in `after` runs after the fan-out child nodes and the descendant nodes added by `spawn` have ended.

<h2 id="実行条件">Execution conditions</h2>

By default, a node runs only when all the nodes it depends on have succeeded.
`trigger` specifies the behavior when a dependency fails.

| Value | Condition for running |
| --- | --- |
| `'success'` | All dependencies succeeded. Default |
| `'failure'` | At least one dependency is `FAILED`, `STALLED`, or `CANCELLED` |
| `'always'` | All dependencies have ended, regardless of success or failure |

```ts
const flows = {
  BACKUP: flow<{ target: string }>((f) => {
    const dump = f.node('dump', 'DUMP', { input: (i) => ({ target: i.target }) });

    // 失敗時のみ実行
    f.node('alert', 'ALERT', {
      after: { dump },
      trigger: 'failure',
      input: (i) => ({ message: `backup failed: ${i.target}` }),
    });

    // 成否によらず実行
    f.node('unlock', 'UNLOCK', { after: { dump }, trigger: 'always', input: (i) => ({ target: i.target }) });
  }),
};
```

Specifying `trigger` on a node without `after` causes an error.
Only nodes that actually failed count toward the `'failure'` condition.
A node that became `SKIPPED` because it did not satisfy a `trigger` or `when` condition does not count as a failure.
If all the nodes it depends on are `SKIPPED`, a `'failure'` node does not run.

With `'failure'` and `'always'`, a failed node has no return value.
The type of the second argument of `input` includes `undefined`, so write code that handles the case where there is no value.

```ts
f.node('alert', 'ALERT', {
  after: { dump },
  trigger: 'always',
  // d.dumpはundefinedの可能性あり
  input: (_i, d) => ({ size: d.dump?.size ?? 0 }),
});
```

<h2 id="条件分岐">Conditional branching</h2>

`when` decides whether a node runs, based on the Flow input and the results of preceding nodes.
If `when` returns `false`, the node transitions to `SKIPPED`, and the subsequent nodes that depend on it do not run either.
If an exception occurs inside `when`, the node transitions to `FAILED`.

```ts
f.node('detail', 'DETAIL', {
  after: { list },
  when: (i, d) => i.verbose && d.list.items.length > 0,
  input: (_i, d) => ({ items: d.list.items }),
});
```

When evaluating `when` and `input`, use only the values passed as arguments and do not make external queries.

<h2 id="失敗時の動作">Behavior on failure</h2>

When a node fails, subsequent nodes that depend on it with `'success'` transition to `SKIPPED`.
Subsequent nodes whose `trigger` is `'failure'` or `'always'` run.
Nodes that do not depend on the failed node run to completion.
When all nodes have ended, the Run transitions to `FAILED`.

A Run becomes `FAILED` only when there is a failed node.
Nodes that did not run because of a `trigger` or `when` condition do not count as failures.
Even if a `trigger: 'failure'` node succeeds, the Run ends as `FAILED` if a preceding node failed.
The reason a node became `SKIPPED` is recorded in the node's `error` and shown in the Run details on the dashboard.

Resume a `FAILED` Run from the dashboard or the REST API.
The results of nodes that succeeded are used as they are, and the other nodes are treated as not yet run and are run again.
However, among the child nodes of a fan-out, child nodes that ran and failed are not re-run.
Those failures remain counted in `failed` of the fan-out aggregate value and are carried over to subsequent nodes.
Child nodes that were aborted because the Run exceeded its deadline or the node count limit are re-run.

Succeeded nodes downstream of a node that is run again are also treated as not yet run and are re-run, and the same rule applies to the nodes downstream of those.
As a result, `trigger: 'failure'` and `trigger: 'always'` nodes run again against the results after the resume.
Fan-out nodes, subflow nodes, and nodes that added child nodes with `ctx.spawn` are not re-run if they succeeded, even when they are downstream, and their results are used as they are.

<h2 id="取り消し">Cancellation</h2>

When you cancel a Run, nodes that have not yet run are not started.
A [cancellation request](/en/guide/execution#実行中の取り消し) is sent to running nodes.
Running jobs are not stopped.
The Run transitions to `CANCELLED` when the performer checks the request and finishes, or when no result has been reported within `reaperGraceMs` (default 30 seconds) of the request.

<h2 id="期限">Deadline</h2>

Specify the deadline for the whole Run in the second argument of the Flow definition.

```ts
const GREETINGS = flow<{ prefix: string }>(
  (f) => {
    // ...
  },
  { deadlineMs: 10 * 60 * 1000 },
);
```

Specify `deadlineMs` as a positive integer (in milliseconds).
If you pass `{ deadlineMs }` as the fourth argument of `start`, that value takes precedence.

A Run that passes its deadline is aborted by the same procedure as cancellation.
Nodes that have not yet run transition to `FAILED` with the error `run deadline exceeded`.
Running jobs are not stopped, and the Run transitions to `FAILED` when those jobs end.
Child Runs that are running are cancelled.

A Run that does not finish by the deadline transitions to `FAILED` even if all the remaining nodes succeed.
Whether the deadline has passed is judged by the time at which the Run processes the end of the last node, not the time at which the node ended.
Therefore, even if the last node ends just before the deadline, the Run transitions to `FAILED` if the time at which the Run processes that end is past the deadline.
Such a Run can be resumed, like any ordinary failure.
When it is resumed, the deadline is measured anew from the time of the resume.

<h2 id="保持期間">Retention period</h2>

A finished Run is deleted after `runs.sweepAfterMs` (default 5 minutes) has elapsed.
A `FAILED` Run is deleted after `runs.failedRetentionMs` (default 7 days) has elapsed.
For details, see [RunSettings](/en/reference/config#runsettings).

<h2 id="デプロイと実行中のrun">Deployment and running Runs</h2>

A running Run continues with the node configuration it had when it started.
If you change functions such as `input`, the change takes effect from the next node that starts.

If you remove a node from the definition, a running Run that contains that node fails at that node.
When you remove a node, deploy after all running Runs have finished.

<h2 id="テスト">Testing</h2>

`simulateFlow` verifies the execution order of nodes and the payload passed to each node for a given input.
It does not run the actual processing of the performers.

```ts
import { simulateFlow } from 'tsumugi/testing';

const result = simulateFlow(flows.GREETINGS, { prefix: 'hello' }, { results: { list: { names: ['a', 'b'] } } });

expect(result.nodes.map((node) => node.id)).toEqual(['list', 'greet:0', 'greet:1', 'greet', 'report']);
expect(result.nodes[1].payload).toEqual({ name: 'a' });
```

Pass the return value of each node to `results`, keyed by node ID.
A value can be either the return value itself or a function that produces it.
The return value of a node you do not pass is `undefined`.
A node passed to `fails` fails, and its subsequent nodes transition to `SKIPPED`.
The Run transitions to `FAILED`.
Fan-out child nodes are created from the return value of `over`, but child nodes added by `ctx.spawn` are not included.
`simulateFlow` does not run the child Flow of a subflow node.
The `payload` of a subflow node is the input of the child Run.
A subflow node becomes `COMPLETED` unless it is specified in `fails`.

<h2 id="制約">Limits</h2>

`uniqueKey` cannot be used on a node.
Specifying a performer that requires `uniqueKey` as a node causes a type error.

If the return value of a node exceeds 8,192 characters, or cannot be serialized, the attempt is treated as a failure.
After a failure, retries are made up to `maxAttempts`.
Write large results to R2 or a similar store and return a reference to them.

By default, a single Run can contain up to 10,000 nodes.
By default, subflows can be nested up to 3 levels.
Change these limits with `runs.maxNodes` and `runs.maxDepth` in `defineTsumugi`.

<h2 id="設定">Configuration</h2>

When you specify `flows`, add the following two entries to your wrangler configuration.
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

Export `TsumugiRun` by extending `runClass`, which is included in the return value of `defineTsumugi`.
You need to apply the D1 migrations again.

```ts
export { TsumugiJobShard } from 'tsumugi';
export class TsumugiRun extends tsumugi.runClass {}
```

```bash
pnpm wrangler d1 migrations apply my-jobs --remote
```
