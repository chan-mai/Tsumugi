---
title: Overview
description: The problems that Tsumugi, a job management system for Cloudflare Workers, solves, the code you write, and the prerequisites
publishedAt: 2026-07-22
updatedAt: 2026-10-25
---

<h1 id="概要">Overview</h1>

Tsumugi is a job management system designed for Cloudflare Workers.
You define job processing as a performer and submit jobs with enqueue.
Tsumugi handles job delivery, execution, and state recording.
It also provides a management dashboard and a REST API.

<h2 id="何を解決するの">What problems does it solve</h2>

Using Cloudflare Queues directly as a job queue causes several problems.

<h3 id="ジョブの状態を管理しづらく成功したジョブが残らない">Job state is hard to manage, and successful jobs are not retained</h3>

Queues does not provide an API to query the state of a message you have submitted.
Successful messages are not retained either, and there is no way to review past executions later.

The Tsumugi dashboard and REST API provide listing, search, and aggregation for both running and finished jobs.
When you configure the `TSUMUGI_METRICS` binding, failure rate and execution time are recorded as metrics.

<h3 id="排他制御と重複排除を実装しづらい">Exclusive control and deduplication are hard to implement</h3>

Queues does not manage dependencies or relationships between messages.
As a result, you must implement on your own the prevention of concurrent execution for the same customer and the elimination of duplicate submissions.

In Tsumugi, jobs with a `concurrencyKey` run one at a time, in order, among jobs that share the same key.
When you specify `uniqueKey`, a job submitted with the same key within a certain period is treated as a duplicate, and the existing job ID is returned without creating a new job.

<h3 id="ジョブの種類が増えるほど分岐が増える">More job types mean more branching</h3>

With Queues, you can configure only one consumer per queue.
As a result, as job types increase, you must either add more queues or accept increasingly complex branching inside the consumer.

Tsumugi distinguishes job types by using the export name of the performer as the binding name, so you do not need to write branching in the consumer.
The relationship between the binding name and the payload type is explained in [binding name](/en/guide/performer#binding名).

<h3 id="まれにメッセージが失われる">Messages are occasionally lost</h3>

Queues does not provide a way to detect messages that were lost without being processed.

Tsumugi treats a job as unresponsive when a job that has started executing does not report a result.
With `at-least-once` semantics, an unresponsive job is enqueued again.
With `at-most-once` semantics, an unresponsive job moves to the `STALLED` state and is not executed until it is retried manually.

<h2 id="利用者が記述するコード">Code you write</h2>

You write code in only two places: the job processing definition and the enqueue call.

```ts
import { defineTsumugi } from 'tsumugi';
import { Performer } from 'tsumugi/performer';

// 1. Define the job processing as a performer and export it
export class SendMail extends Performer<{ to: string }, void, {}, Env> {
  async perform(payload: { to: string }): Promise<void> {
    await this.env.MAILER.send(payload.to);
  }
}

const tsumugi = defineTsumugi({ performers: { SendMail } });

// 2. Enqueue the job. The binding name is the exported name
const id = await tsumugi.enqueue(env, { binding: 'SendMail', payload: { to: 'a@example.com' } });
```

You do not need to write queue configuration, consumer branching, or state recording.
Each feature is explained in [Enqueueing Jobs](/en/guide/enqueue), [Execution Control](/en/guide/execution), [Scheduled Execution](/en/guide/schedule), and [Dashboard and Authentication](/en/guide/dashboard).

<h2 id="前提条件">Prerequisites</h2>

The Workers Paid plan is required.
Set `compatibility_date` to 2025-11-17 or later and add `temporal` to `compatibility_flags`, or set `compatibility_date` to 2026-12-01 or later.
Create the required resources and settings with `npx tsumugi init`.
For the steps, see [Getting Started](/en/guide/getting-started).

<h2 id="着想">Inspiration</h2>

The idea of bundling a dashboard with a job queue that runs entirely on Cloudflare services was inspired by [Kiribi](https://kiribi.pages.dev/).
Tsumugi also shares with Kiribi the policy of minimizing setup steps and not making users aware of the internal architecture.

Tsumugi provides execution volume limits, per-job execution guarantees, retry control, multi-stage execution with Flow, and scheduled execution.
Because of these features, the resources and settings you must prepare are greater than with Kiribi.
