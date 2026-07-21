# Getting Started

## 用意するもの

- Workers Paidプランの有効なCloudflareアカウント(SQLite版のDurable ObjectsとQueuesの両方が要求)
- `compatibility_date`は2025-11-17以降(自己参照のservice bindingを`ctx.exports`で解決するため)

## インストール

```bash
npm create cloudflare@latest my-jobs -- --type=hello-world
cd my-jobs
npm install tsumugi
```

## リソース作成

D1とQueuesを先に作ります

```bash
npx wrangler d1 create my-jobs
npx wrangler queues create my-jobs
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
`max_retries`はTsumugiの試行回数とは無関係です。consumerは結果をDurable Objectへ報告したあと必ず即ackするので、Queues側のretryは配送そのものが失敗したときにしか効きません
:::

## 読み取りモデルの作成

一覧と検索が参照するD1のテーブルを作成します

```bash
npx wrangler d1 migrations apply my-jobs --local
npx wrangler d1 migrations apply my-jobs --remote
```

## Worker

performerを定義して、`defineTsumugi`に登録簿として渡します

```ts
import { bearerAuth, defineTsumugi, enqueue } from 'tsumugi';
import { Performer } from 'tsumugi/performer';
import { ui } from 'tsumugi/ui';

class Hello extends Performer<{ name: string }, void, {}, Env> {
  async perform(payload: { name: string }): Promise<void> {
    console.log(`hello, ${payload.name}`);
  }
}

const tsumugi = defineTsumugi<Env>({
  performers: { HELLO: Hello },
  auth: bearerAuth((env: Env) => env.TSUMUGI_TOKEN, { cookie: 'tsumugi_token' }),
  ui: ui({ tokenCookie: 'tsumugi_token' }),
});

// Durable Objectクラスの再エクスポートが要る
export { TsumugiJobShard } from 'tsumugi';

export default {
  ...tsumugi,
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/enqueue') {
      const id = await enqueue(env, { binding: 'HELLO', payload: { name: 'world' } });
      return Response.json({ id });
    }
    // 残りはダッシュボードとREST APIへ
    return tsumugi.fetch!(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
```

`defineTsumugi`が返すのは`fetch`と`queue`と`scheduled`を持つハンドラです
独自の`fetch`を追加する場合は上のようにスプレッドし、処理しなかったパスを`tsumugi.fetch`へ渡します

## トークンの設定

認証はfail-closedです。設定するまでREST APIもダッシュボードも404を返します

```bash
npx wrangler secret put TSUMUGI_TOKEN
```

ローカルで動かすときは`.dev.vars`に書きます

```
TSUMUGI_TOKEN=ローカル用のトークン
```

## 起動

```bash
npx wrangler dev
```

`/enqueue`にアクセスするとジョブIDが返ります。`/`を開くとダッシュボードが表示されるので、トークンを入力すると一覧を確認できます

## 次に読むもの

- [Performer](/guide/performer): ジョブの中身の書きかた
- [ジョブの投入](/guide/enqueue): 予約実行、優先度、重複排除
- [実行の制御](/guide/execution): 状態、リトライ、流量制御、実行保証
