# Tsumugi

[![npm](https://img.shields.io/npm/v/tsumugi?style=flat-square&logo=npm&logoColor=white&label=npm&color=f7a1b2)](https://www.npmjs.com/package/tsumugi)
[![CI](https://img.shields.io/github/actions/workflow/status/chan-mai/Tsumugi/ci.yaml?branch=develop&style=flat-square&logo=github&logoColor=white&label=CI&color=f7a1b2)](https://github.com/chan-mai/Tsumugi/actions/workflows/ci.yaml)
[![License](https://img.shields.io/npm/l/tsumugi?style=flat-square&label=license&color=f7a1b2)](./LICENSE)
[![Docs](https://img.shields.io/badge/docs-tsumugi.mq1.dev-f7a1b2?style=flat-square&logo=readthedocs&logoColor=white)](https://tsumugi.mq1.dev)

![Cloudflare Workers](https://img.shields.io/badge/Cloudflare_Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)
![Durable Objects](https://img.shields.io/badge/Durable_Objects-F38020?style=flat-square)
![Queues](https://img.shields.io/badge/Queues-F38020?style=flat-square)
![D1](https://img.shields.io/badge/D1-F38020?style=flat-square)
![Analytics Engine](https://img.shields.io/badge/Analytics_Engine-F38020?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)

A job management system designed for the Cloudflare stack.

Cloudflareスタック向けに設計されたジョブ管理システム

See documentation at [https://tsumugi.mq1.dev](https://tsumugi.mq1.dev)

ドキュメントは[https://tsumugi.mq1.dev](https://tsumugi.mq1.dev)にあります

## Requirements

- A **paid Workers plan**. SQLite-backed Durable Objects and Queues both require it.
- `compatibility_date` of **2025-11-17 or later**, for `ctx.exports`.
- A **D1 database** for the read model. Migrations shipped with the package must be applied.
- **Analytics Engine** is optional, and only needed for time series metrics.



- **Workers Paid**が必要, SQLite版のDurable ObjectsとQueuesの両方が必要とする
- `compatibility_date`は**2025-11-17以降**, `ctx.exports`のため
- **D1**が必要, 読み取りモデルの置き場でパッケージ同梱のマイグレーションの適用が必要
- **Analytics Engine**は任意, 時系列メトリクスを書く場合だけ設定する

## Quickstart

```bash
pnpm create cloudflare@latest my-jobs --type=hello-world
cd my-jobs
pnpm add tsumugi
npx tsumugi init
```

`tsumugi init` creates the D1 database and the queue, generates the wrangler config and the source templates, and applies the migrations.

`tsumugi init`はD1とQueuesの作成, wrangler設定とソースの雛形の生成, マイグレーションの適用までを行います

See [Getting Started](https://tsumugi.mq1.dev/guide/getting-started) for what is generated and how to handle an existing configuration.

生成される内容と既存の設定がある場合の扱いは[Getting Started](https://tsumugi.mq1.dev/guide/getting-started)を参照してください

## Usage

Write the body of the job as a performer.

ジョブの処理内容はperformerに記述します

```ts
// src/performers/send-mail.ts
import { Performer } from 'tsumugi/performer';

export class SendMail extends Performer<{ to: string }, void, {}, Env> {
  async perform(payload: { to: string }): Promise<void> {
    await this.env.MAILER.send(payload.to);
  }
}
```

Export the performers from the top level of the Worker and enqueue by binding name. The binding name is the exported name, and the payload type is derived from the same place.

performerはWorkerのトップレベルからexportし, binding名を指定して投入します。binding名はexportした名前がそのまま使われ, payloadの型も同じ場所から決定されます

```ts
// src/index.ts
import { bearerAuth, defineTsumugi } from 'tsumugi';
import { ui } from 'tsumugi/ui';
import * as performers from './performers/index.js';

export * from './performers/index.js';
export { TsumugiJobShard } from 'tsumugi';

const tsumugi = defineTsumugi({
  performers,
  auth: bearerAuth((env: Env) => env.TSUMUGI_TOKEN, { cookie: 'tsumugi_token' }),
  ui: ui({ tokenCookie: 'tsumugi_token' }),
});

export default {
  ...tsumugi,
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/enqueue') {
      const id = await tsumugi.enqueue(env, { binding: 'SendMail', payload: { to: 'a@example.com' } });
      return Response.json({ id });
    }
    return tsumugi.fetch!(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
```

Scheduled execution, priority, deduplication, rate limits, Flow, recurring execution and the REST API are described in the documentation.

予約実行, 優先度, 重複排除, 流量制御, Flow, 定期実行, REST APIについてはドキュメントを参照してください

## Development

Node.js 22 and pnpm are required. This repository is a pnpm workspace.

Node.js 22とpnpmが必要です。このリポジトリはpnpmのワークスペースです

```bash
pnpm install
pnpm build
pnpm test
```

### Layout

| Path                        | Description                             |
| --------------------------- | --------------------------------------- |
| `packages/tsumugi`          | The published package and its CLI       |
| `packages/dashboard`        | Dashboard UI, built into the package    |
| `packages/spec`             | TypeSpec definition of the REST API     |
| `examples/basic`            | Worker that defines and runs performers |
| `examples/remote-performer` | Performers placed in a separate Worker  |
| `site`                      | Documentation site                      |
| `docs/decision`             | Architecture decision records           |

### Commands

| Command             | Description                                    |
| ------------------- | ---------------------------------------------- |
| `pnpm build`        | Builds the dashboard, the spec and the package |
| `pnpm typecheck`    | Typechecks every workspace                     |
| `pnpm test`         | Typecheck and all test projects                |
| `pnpm test:unit`    | Pure functions, runs without workerd           |
| `pnpm test:workers` | Tests running on workerd                       |
| `pnpm format`       | Formats with Prettier                          |

To run the documentation site or an example locally, use the workspace filter.

ドキュメントサイトやexampleを動かす場合はワークスペースを指定します

```bash
pnpm --filter @tsumugi/site dev
pnpm --filter tsumugi-example-basic dev
```

## License

MIT
