---
title: Dashboard and Authentication
description: How to configure authentication for the REST API and the dashboard, and how to view, search, and bulk-operate on jobs and Runs in the dashboard
publishedAt: 2026-07-22
updatedAt: 2026-10-25
---

<h1 id="ダッシュボードと認証">Dashboard and Authentication</h1>

::callout{type="warning"}
If `auth` is not specified, all requests to the REST API and the dashboard receive a 404 response.
::

<h2 id="bearerauth">bearerAuth</h2>

`bearerAuth` authenticates requests with a single token.

```ts
import { bearerAuth, defineTsumugi } from 'tsumugi';

const tsumugi = defineTsumugi({
  performers,
  auth: bearerAuth((env: Env) => env.TSUMUGI_TOKEN, { cookie: 'tsumugi_token' }),
});
```

Retrieve the token from a secret with a function, as in the example above.
Writing the token directly as a string puts it in both the repository and the bundle, which creates a security risk.

<h3 id="cookie">cookie</h3>

When you specify the `cookie` option, Tsumugi verifies the token in the cookie with the specified name, in addition to the `Authorization` header.
Browsers do not send an `Authorization` header when fetching the initial HTML.
This setting is required to open the dashboard.

Cookie-based authentication may be exposed to CSRF.
The side that issues the cookie should explicitly specify `SameSite=Strict`.

<h2 id="cloudflare-access">Cloudflare Access</h2>

If you specify `cloudflareAccess`, Tsumugi verifies the JWT issued by Cloudflare Access.
`auth` accepts the return values of `bearerAuth`, `cloudflareAccess`, and `unsafeNoAuth`, as well as any Hono middleware.

```ts
import { cloudflareAccess, defineTsumugi } from 'tsumugi';

const tsumugi = defineTsumugi({
  performers,
  auth: cloudflareAccess({ teamDomain: 'example', aud: 'audience tag' }),
});
```

| Name | Description |
| --- | --- |
| `teamDomain` | The team part of `<team>.cloudflareaccess.com` |
| `aud` | The audience tag of the Access application |
| `cacheTtlMs` | The refetch interval for the JWKS. Defaults to 1 hour |

<h2 id="認証しない構成">Running Without Authentication</h2>

::callout{type="danger"}
If you specify `unsafeNoAuth`, the REST API and the dashboard do not require authentication.
Every user who can reach the Worker can view job contents, including the payload, and can enqueue, cancel, and rerun jobs.
Do not use it in a public environment.
::

Use `unsafeNoAuth` only when authentication is performed in front of Tsumugi.
Examples include a setup where Cloudflare Access is applied to the entire route, and checking behavior with `wrangler dev`.
To run without authentication, do not omit `auth`; specify `unsafeNoAuth` explicitly.
A warning is logged while `unsafeNoAuth` is in use.

```ts
import { defineTsumugi, unsafeNoAuth } from 'tsumugi';

const tsumugi = defineTsumugi({
  performers,
  auth: unsafeNoAuth(),
});
```

<h2 id="ダッシュボードの有効化">Enabling the Dashboard</h2>

If you pass `ui()` from `tsumugi/ui` to the `ui` option of `defineTsumugi`, GET requests to paths other than `/api` receive the dashboard HTML.
If you do not specify `ui`, the dashboard is not included in the bundle.
When the API responds with 401, the dashboard shows a token input field.

```ts
import { ui } from 'tsumugi/ui';

const tsumugi = defineTsumugi({
  performers,
  auth: bearerAuth((env: Env) => env.TSUMUGI_TOKEN, { cookie: 'tsumugi_token' }),
  ui: ui({ tokenCookie: 'tsumugi_token' }),
});
```

| Name | Description |
| --- | --- |
| `tokenCookie` | The name of the cookie that stores the token. Use the same value as `cookie` in `bearerAuth` |

<h2 id="ジョブの一覧">Job List</h2>

In the job list, you can filter by status, binding, and creation time range, and use paging and per-column sorting.
It also provides search by job ID, `uniqueKey`, and `concurrencyKey`.
The job detail page shows the attempt history, progress, logs, and trace information.
Manual retry and cancel, bulk retry and bulk cancel of selected jobs, and enqueueing jobs are also done from the job list page.

![Job list page](/dashboard-jobs.jpg)

<h3 id="検索">Search</h3>

The value entered in the search field is matched exactly.
If you enter a value that matches the job ID format, the details of that job are shown.

<h3 id="一括操作">Bulk Operations</h3>

Select jobs with the checkbox at the left end of each row.
The checkbox in the header row selects all displayed rows.
When one or more rows are selected, a menu appears for retrying or canceling the selected jobs together.

<h3 id="表示の設定">Display Settings</h3>

Display settings are saved in the browser and applied from the next visit on.
The refresh interval is chosen from Off, 1s, 3s, 10s, 30s, and 1m, and the default is 3 seconds.
You can toggle the display of the ID, Started at, Updated at, Attempts, and Processing time columns.
Binding and Status are always shown.
The page size is chosen from 10, 20, 30, and 50.
For the language, switch between 日本語 and English at the bottom of the sidebar.
On the first visit, the dashboard follows the browser's language setting.

<h3 id="時刻の表示">Time Display</h3>

Scheduled run times are shown in each schedule's time zone.
All other times are shown in the browser's IANA time zone.
Every time is shown with its IANA time zone and GMT offset.
The creation time range is specified by year, month, and day in the browser's local date.

<h2 id="ジョブの詳細">Job Details</h2>

<h3 id="試行履歴">Attempt History</h3>

The start time, end time, and error of each attempt are shown in the job details.
For the number of attempts that are stored and the maximum length of the error body, see [Failures and Retries](/en/guide/performer#失敗とリトライ).
The attempt history is included only in the job detail response, not in the list response.
An attempt that succeeds on the first try is not recorded in the history.

![Attempt history display](/dashboard-attempts.jpg)

<h3 id="ログとトレース情報">Logs and Trace Information</h3>

Messages saved with `ctx.log()` appear in the job details in the order received.
Each log includes the attempt number, the recorded time, and the body.
Logs of a running job are also shown, but it may take some time for them to appear.
For the maximum number of logs, the maximum body length, and the save interval, see [Logs](/en/guide/performer#ログ).
The log retention period is the same as the job retention period.

For a job enqueued with `traceparent` specified, that value is shown in the job details.
For how to use it in a performer, see [Trace Information](/en/guide/performer#トレース情報).

<h3 id="リトライ可否の表示">Retryability Display</h3>

Each row in the list includes `retryable`.
`retryable` indicates whether the job is `FAILED` or `STALLED` and is within its retention period.
A successful retry is not guaranteed.
The REST API responds with 410 to a retry request for a job past its retention period.

<h2 id="runs">Runs</h2>

If `flows` is configured, a Runs item appears in the sidebar.
If `flows` is empty, it is not shown.

The Run list shows the Flow, status, and node progress.
If you specify a Flow or a status, only the matching Runs are shown in the list.
Selecting a row opens a detail panel.
The detail panel offers two views: a graph and a waterfall.

![Run waterfall](/dashboard-run.jpg)

The waterfall lays out the execution time of each node on a time axis.
The graph shows the dependencies between nodes, the status of each node, and the progress of the child nodes of a fan-out node.
Up to 24 child nodes are shown, and the remainder is shown as a count for each status.
Selecting a waterfall row or a graph node opens the details of that job.

In the details of a Run started as a subflow, the ID of the parent Run is shown as a link.
Selecting this link opens the details of the parent Run.
A subflow node on the graph has a button that opens the details of the child Run.
Selecting a subflow row in the waterfall also opens the details of the child Run.

Starting, resuming, and canceling a Run are done from the Runs page.
Only `FAILED` Runs can be resumed, and only `RUNNING` Runs can be canceled.
