---
title: Dashboard and Authentication
description: How to configure authentication for the REST API and the dashboard, and how to view, search, and bulk-operate on jobs and Runs in the dashboard
publishedAt: 2026-07-22
updatedAt: 2026-10-30
---

<h1 id="ダッシュボードと認証">Dashboard and Authentication</h1>

::callout{type="warning"}
If you do not specify `auth`, all requests to the REST API and the dashboard receive a 404 response.
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

Retrieve the token from a Secret with a function, as in the example above.
Writing the token directly as a string is a security risk, because the token ends up in both the repository and the bundle.

<h3 id="cookie">cookie</h3>

If you specify the `cookie` option, the token in the cookie with the specified name is validated in addition to the `Authorization` header.
Browsers do not send the `Authorization` header when fetching the initial HTML.
This setting is required to open the dashboard.

Cookie authentication can be subject to CSRF.
The side that issues the cookie should explicitly specify `SameSite=Strict`.

<h2 id="cloudflare-access">Cloudflare Access</h2>

If you specify `cloudflareAccess`, Tsumugi verifies the JWT issued by Cloudflare Access.

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
| `cacheTtlMs` | The refetch interval for the JWKS. The default is 1 hour |

<h2 id="独自の認証">Custom Authentication</h2>

To implement custom authentication, specify a function for the `auth` option.
The function's arguments are `request` and `env`.
The function returns a `Response` or `undefined`.
If it returns `undefined`, authentication succeeds and Tsumugi continues processing the request.
If it returns a `Response`, authentication fails, and Tsumugi responds with that `Response` and stops processing.
For example, you can check the session with `findSession` and return a 401 `Response` if none exists.

```ts
import { defineTsumugi } from 'tsumugi';

const tsumugi = defineTsumugi({
  performers,
  auth: async (request, env: Env) => {
    const session = await findSession(request, env);
    return session ? undefined : Response.json({ error: 'unauthorized' }, { status: 401 });
  },
});
```

<h2 id="認証しない構成">Configuration Without Authentication</h2>

::callout{type="danger"}
If you specify `unsafeNoAuth`, the REST API and the dashboard do not require authentication.
Anyone who can reach the Worker can view job contents, including the payload, and can enqueue, cancel, and rerun jobs.
Do not use it in a public environment.
::

Use `unsafeNoAuth` only when authentication happens in front of Tsumugi.
Examples are a setup where Cloudflare Access is applied to the entire route, and checking behavior with `wrangler dev`.
To run without authentication, do not omit `auth`; specify `unsafeNoAuth` explicitly.
While `unsafeNoAuth` is specified, a warning is written to the log.

```ts
import { defineTsumugi, unsafeNoAuth } from 'tsumugi';

const tsumugi = defineTsumugi({
  performers,
  auth: unsafeNoAuth(),
});
```

<h2 id="ダッシュボードの有効化">Enabling the Dashboard</h2>

If you pass `ui()` from `tsumugi/ui` to the `ui` option of `defineTsumugi`, Tsumugi responds with the dashboard HTML to GET requests for paths other than `/api`.
If you do not specify `ui`, the dashboard is not included in the bundle.
When the API responds with 401, the dashboard shows a token input field.
The dashboard runs in browsers that support the Temporal API (Chrome 144 or later, Edge 144 or later, Firefox 139 or later, Safari 27.3 or later).


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
| `tokenCookie` | The name of the cookie that stores the token. Use the same value as `cookie` of `bearerAuth` |

<h2 id="ジョブの一覧">Job List</h2>

In the job list, you can filter by status, binding, and creation date range, and use paging and per-column sorting.
You can also search by job ID, `uniqueKey`, and `concurrencyKey`.
The job detail page shows attempt history, progress, logs, and trace information.
Manual retry and cancel, bulk retry and bulk cancel of selected jobs, and enqueueing jobs are also available on the job list page.

![Job list page](/dashboard-jobs.jpg)

<h3 id="検索">Search</h3>

A value entered in the search box is matched exactly.
If you enter a value that matches the job ID format, the details of that job are shown.

<h3 id="一括操作">Bulk Operations</h3>

Select jobs with the checkbox at the left end of each row.
The checkbox in the header row selects all displayed rows.
When one or more jobs are selected, a menu appears for retrying or canceling the selected jobs together.

<h3 id="表示の設定">Display Settings</h3>

Display settings are saved in the browser and applied from the next visit on.
Choose the refresh interval from Off, 1s, 3s, 10s, 30s, and 1m; the default is 3 seconds.
You can toggle the display of the columns ID, Started at, Updated at, Attempts, and Processing time.
Binding and Status are always shown.
Choose the number of items per page from 10, 20, 30, and 50.
Switch the language between 日本語 and English at the bottom of the sidebar.
On the first visit, the language follows the browser's language setting.

<h3 id="時刻の表示">Time Display</h3>

Times for scheduled runs are shown in each schedule's time zone.
All other times are shown in the browser's IANA time zone.
Every time is shown with its IANA time zone and GMT offset.
The creation date range is specified by year, month, and day in the browser's local date.

<h2 id="ジョブの詳細">Job Details</h2>

<h3 id="試行履歴">Attempt History</h3>

The start time, end time, and error of each attempt appear in the job details.
For the limits on the number of stored attempts and the length of the error body, see [Failures and Retries](/en/guide/performer#失敗とリトライ).
Attempt history is included only in the job detail response, not in the list response.
An attempt that succeeds on the first try is not recorded in the history.

![Attempt history view](/dashboard-attempts.jpg)

<h3 id="ログとトレース情報">Logs and Trace Information</h3>

Messages saved with `ctx.log()` appear in the job details in the order received.
Each log includes the attempt number, the recorded time, and the body.
Logs of running jobs are also shown, but it may take some time before they appear.
For the limits on the number of stored entries, body length, and save interval, see [Logs](/en/guide/performer#ログ).
The log retention period is the same as the job retention period.

For a job enqueued with `traceparent` specified, that value appears in the job details.
For how to use it in the performer, see [Trace Information](/en/guide/performer#トレース情報).

<h3 id="リトライ可否の表示">Retryability Display</h3>

Each row in the list includes `retryable`.
`retryable` indicates whether the job is `FAILED` or `STALLED` and within its retention period.
A successful retry is not guaranteed.
The REST API responds with 410 to a retry request for a job past its retention period.

<h2 id="runs">Runs</h2>

If `flows` is configured, a Runs item appears in the sidebar.
If `flows` is empty, it is not shown.

The Run list shows the Flow, status, and node progress.
If you specify a Flow or status, only matching Runs are listed.
Select a row to open the detail panel.
The detail panel offers two views: graph and waterfall.

![Run waterfall](/dashboard-run.jpg)

The waterfall lays out the execution time of each node along a time axis.
The graph shows node dependencies, the status of each node, and the progress of child nodes of fan-out nodes.
Up to 24 child nodes are shown, and the excess is shown as counts per status.
Select a waterfall row or a graph node to open the details of that job.

The details of a Run started as a subflow show the parent Run's ID as a link.
Select this link to open the parent Run's details.
A subflow node in the graph has a button to open the child Run's details.
Selecting a subflow row in the waterfall also opens the child Run's details.

Start, resume, and cancel Runs on the Runs page.
Resume applies to `FAILED` Runs, and cancel applies to `RUNNING` Runs.
