# Getting Started

## 用意するもの

- Workers Paidプランの有効なCloudflareアカウント(SQLite版のDurable ObjectsとQueuesの両方が要求)
- `compatibility_date`は2025-11-17以降(自己参照のservice bindingを`ctx.exports`で解決するため)

## インストール

```bash
pnpm create cloudflare@latest my-jobs --type=hello-world
cd my-jobs
pnpm add tsumugi
```

## リソース作成

D1とQueuesを先に作ります

```bash
pnpm wrangler d1 create my-jobs
pnpm wrangler queues create my-jobs
```

## wrangler.jsonc

Tsumugiが使うbindingは4つです

```jsonc
{
  "name": "my-jobs",
  "main": "src/index.ts",
  "compatibility_date": "2026-07-01",

  "durable_objects": {
    "bindings": [{ "name": "JOB_SHARD", "class_name": "TsumugiJobShard" }],
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["TsumugiJobShard"] }],

  "d1_databases": [
    {
      "binding": "TSUMUGI_DB",
      "database_name": "my-jobs",
      "database_id": "d1 createが出力したid",
      // 読み取りモデルのマイグレーションはパッケージに同梱
      "migrations_dir": "./node_modules/tsumugi/migrations",
    },
  ],

  "queues": {
    "producers": [{ "binding": "TSUMUGI_QUEUE", "queue": "my-jobs" }],
    "consumers": [{ "queue": "my-jobs", "max_batch_size": 10, "max_retries": 5 }],
  },

  "analytics_engine_datasets": [{ "binding": "TSUMUGI_METRICS", "dataset": "tsumugi_jobs" }],

  // D1の読み取りモデルのcleanupをscheduledで実行
  "triggers": { "crons": ["0 * * * *"] },
}
```

::: info
`max_retries`はTsumugiの試行回数とは無関係です。試行回数は`maxAttempts`で指定します
:::

Flowを使う場合はbindingが1つ増えます。単発のジョブのみを扱う構成では不要です
詳細は[Flow](/guide/flow)を参照してください

## 読み取りモデルの作成

一覧と検索が参照するD1のテーブルを作成します

```bash
pnpm wrangler d1 migrations apply my-jobs --local
pnpm wrangler d1 migrations apply my-jobs --remote
```

::: warning
Tsumugiを更新した場合も同じコマンドが必要です。マイグレーションはバージョンによって追加されます
未適用のマイグレーションがある場合、REST APIとダッシュボードは503を返し、未適用のファイル名を応答本文に含めます
:::

## performer

ジョブの処理内容をファイルに分けて定義します

```ts
// src/performers/hello.ts
import { Performer } from 'tsumugi/performer';

export class Hello extends Performer<{ name: string }, void, {}, Env> {
  async perform(payload: { name: string }): Promise<void> {
    console.log(`hello, ${payload.name}`);
  }
}
```

まとめてexportするファイルを1つ置きます。ここに並べた名前がそのままbinding名になります

```ts
// src/performers/index.ts
export * from './hello.js';
```

## Worker

performerをWorkerのトップレベルからexportします。binding名はexportした名前がそのまま利用されます

```ts
import { bearerAuth, defineTsumugi, enqueue } from 'tsumugi';
import { ui } from 'tsumugi/ui';
import * as performers from './performers/index.js';

export * from './performers/index.js';

const tsumugi = defineTsumugi({
  performers,
  auth: bearerAuth((env: Env) => env.TSUMUGI_TOKEN, { cookie: 'tsumugi_token' }),
  ui: ui({ tokenCookie: 'tsumugi_token' }),
});

// Durable Objectクラスの再エクスポートが必要
export { TsumugiJobShard } from 'tsumugi';

export default {
  ...tsumugi,
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/enqueue') {
      const id = await enqueue(env, { binding: 'Hello', payload: { name: 'world' } });
      return Response.json({ id });
    }
    // 残りはダッシュボードとREST APIへ
    return tsumugi.fetch!(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
```

`performers`はペイロードと必須キーの型を引くためのもので、実行時の解決には使いません
解決先はexportした名前なので、`export * from`を書き忘れると実行時に見つからないエラーになります

`defineTsumugi`が返すのは`fetch`と`queue`と`scheduled`を持つハンドラです
独自の`fetch`を追加する場合は上のようにスプレッドし、処理しなかったパスを`tsumugi.fetch`へ渡します

## トークンの設定

認証はfail-closedです。設定するまでREST APIもダッシュボードも404を返します

```bash
pnpm wrangler secret put TSUMUGI_TOKEN
```

## 動作確認

`/enqueue`にアクセスするとジョブIDが返ります
`/`を開くとダッシュボードが表示されます。トークンを入力すると一覧が表示されます

## 次に読むもの

- [Performer](/guide/performer): ジョブの中身の書きかた
- [ジョブの投入](/guide/enqueue): 予約実行、優先度、重複排除
- [実行の制御](/guide/execution): 状態、リトライ、流量制御、実行保証
