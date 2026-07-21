# Tsumugi

A job management system designed for the Cloudflare stack.

Cloudflareスタック向けに設計されたジョブ管理システム

See documentation at [https://tsumugi.mq1.dev](https://tsumugi.mq1.dev).


## Requirements(要件)

- A **paid Workers plan**. SQLite-backed Durable Objects and Queues both require it.
- `compatibility_date` of **2025-11-17 or later**, for `ctx.exports`.

- **Workers Paid**が必要, SQLite版のDurable ObjectsとQueuesの両方が必要とする
- `compatibility_date`は**2025-11-17以降**, `ctx.exports`のため

## Quickstart

```bash
pnpm create cloudflare@latest my-jobs --type=hello-world
cd my-jobs
pnpm add tsumugi
```
