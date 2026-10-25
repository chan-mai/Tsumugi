---
title: Overview
description: The problems Tsumugi, a job management system for Cloudflare Workers, solves, the code you write, and the prerequisites
publishedAt: 2026-07-22
updatedAt: 2026-10-25
---

<h1 id="概要">Overview</h1>

Tsumugi is a job management system designed for Cloudflare Workers.
You define job processing as a performer and submit jobs with enqueue.
Tsumugi handles job delivery, execution, and state recording.
It also provides a management dashboard and a REST API.

<h2 id="何を解決するの">What problems does it solve?</h2>

Using Cloudflare Queues directly as a job queue causes several problems.

<h3 id="ジョブの状態を管理しづらく成功したジョブが残らない">Job state is hard to manage, and successful jobs are not retained</h3>

Queues does not provide an API for querying the state of a message you have submitted.
Successful messages are not retained either, so there is no way to review past executions later.

Tsumugi's dashboard and REST API provide listing, search, and aggregation for both running jobs and finished jobs.
When you configure the `TSUMUGI_METRICS` binding, the failure rate and execution time are recorded as metrics.

<h3 id="排他制御と重複排除を実装しづらい">Exclusive control and deduplication are hard to implement</h3>

Queues does not manage dependencies or relationships between messages.
As a result, you must implement on your own the prevention of concurrent execution for the same customer and the elimination of duplicate submissions.

In Tsumugi, jobs that specify a `concurrencyKey` are executed one at a time, in order, among jobs with the same key.
When you specify a `uniqueKey`, a job submitted with the same key within a certain period is treated as a duplicate, and the existing job ID is returned without creating a new job.

<h3 id="ジョブの種類が増えるほど分岐が増える">The more job types you have, the more branching you need</h3>

With Queues, you can set only one consumer for each queue.
As a result, as job types increase, you must either add more queues or deal with increasingly complex branching inside the consumer.

Tsumugi distinguishes job types by using the export name of each performer as the binding name, so you do not need to write branching in a consumer.
The relationship between binding names and payload types is described in [binding名](/en/guide/performer#binding名).

<h3 id="まれにメッセージが失われる">Messages are occasionally lost</h3>

Queues does not provide a way to detect messages that were lost without being processed.

When a job that has started execution does not report a result, Tsumugi determines that the job is unresponsive.
With `at-least-once` semantics, an unresponsive job is re-enqueued.
With `at-most-once` semantics, an unresponsive job transitions to the `STALLED` state and is not executed until it is retried manually.

<h2 id="利用者が記述するコード">The code you write</h2>

You write code in only two places: the job processing definition and the submission.

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

// 2. Submit the job. The binding name is the exported name
const id = await tsumugi.enqueue(env, { binding: 'SendMail', payload: { to: 'a@example.com' } });
```

You do not need to write the queue configuration, consumer branching, or state recording.
Each feature is described in [Enqueueing jobs](/en/guide/enqueue), [Controlling execution](/en/guide/execution), [Scheduled execution](/en/guide/schedule), and [Dashboard and authentication](/en/guide/dashboard).

<h2 id="前提条件">Prerequisites</h2>

You need the Workers Paid plan and a `compatibility_date` of 2025-11-17 or later.
Create the required resources and configuration with `npx tsumugi init`.
For the steps, see [Getting Started](/en/guide/getting-started).

<h2 id="着想">Inspiration</h2>

The design of a job queue built entirely on Cloudflare services, bundled with a dashboard, was inspired by [Kiribi](https://kiribi.pages.dev/).
Tsumugi also shares Kiribi's policy of minimizing the setup steps and keeping the internal architecture hidden from users.

Tsumugi provides execution volume limits, per-job execution guarantees, retry control, multi-stage execution with Flow, and scheduled execution.
Because of these features, the resources and configuration you must prepare are greater than with Kiribi.
