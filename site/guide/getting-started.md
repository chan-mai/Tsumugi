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

## セットアップ

initがリソースの作成から雛形の生成までを行います

```bash
npx tsumugi init
```

新しいプロジェクトでは、実行が終わると次の状態になります

- D1とQueuesが作成済み
- `wrangler.jsonc`が生成済み。`wrangler d1 create`が出力した`database_id`は転記済み
- `src/index.ts`と`src/performers/`と`.dev.vars`が生成済み
- 読み取りモデル(一覧と検索が参照するD1のテーブル)のマイグレーションが適用済み

途中の手順が失敗した場合は警告が表示され、再実行するコマンドが案内されます

既にwrangler設定がある場合は書き換えず、追記する箇所が出力されます
この場合マイグレーションは適用されないため、編集後に出力される手順に沿って適用してください
オプションと生成物の詳細は[CLI](/reference/cli)を参照してください

`TSUMUGI_METRICS`のbindingは任意で、設定しない場合はメトリクスが記録されませんが、その他の動作に影響はありません
Flowを使う場合はbindingが1つ増えます。単発のジョブのみを扱う構成では不要です
詳細は[設定](/reference/config)と[Flow](/guide/flow)を参照してください

::: warning
Tsumugiを更新した場合はマイグレーションの再適用が必要です。マイグレーションはバージョンによって追加されます
`pnpm wrangler d1 migrations apply my-jobs --local`と`--remote`を実行してください
未適用のマイグレーションがある場合、REST APIは503になり、応答本文に未適用のファイル名が含まれます
ダッシュボードの画面自体は表示されますが、一覧の読み込みが同じ理由で失敗します
:::

## performer

ジョブの処理内容はperformerに記述します。init時に生成される`src/performers/hello.ts`が最小の形です

```ts
// src/performers/hello.ts
import { Performer } from 'tsumugi/performer';

export class Hello extends Performer<{ name: string }, void, {}, Env> {
  async perform(payload: { name: string }): Promise<void> {
    console.log(`hello, ${payload.name}`);
  }
}
```

`perform`の中身とpayloadの型を目的に合わせて書き換えてください

performerの追加はadd-performerで行います

```bash
npx tsumugi add-performer send-mail
```

ファイルの生成と、まとめてexportするファイル(`src/performers/index.ts`)への追記が行われます
ここに並べた名前がそのままbinding名になります

```ts
// src/performers/index.ts
export { Hello } from './hello.js';
export { SendMail } from './send-mail.js';
```

## Worker

initが生成する`src/index.ts`は次の形です
performerをWorkerのトップレベルからexportします。binding名はexportした名前がそのまま利用されます

```ts
import { bearerAuth, defineTsumugi } from 'tsumugi';
import { ui } from 'tsumugi/ui';
import * as performers from './performers/index.js';

export * from './performers/index.js';

const tsumugi = defineTsumugi({
  performers,
  // secretから引く, 直書きするとリポジトリとバンドルの両方に残る
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
      const id = await tsumugi.enqueue(env, { binding: 'Hello', payload: { name: 'world' } });
      return Response.json({ id });
    }
    // 残りはダッシュボードとREST APIへ
    return tsumugi.fetch!(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
```

`performers`はペイロードと必須キーの型を引くためのもので、実行時の解決には使いません

`tsumugi.enqueue`では、bindingからpayloadと必須キーの型が決まります
投入の経路は[ジョブの投入](/guide/enqueue#paths)を参照してください

`defineTsumugi`の戻り値には、`fetch`と`queue`と`scheduled`のほかに投入とFlowの開始の口が含まれます
全体は[設定](/reference/config#definetsumugi)を参照してください
独自の`fetch`を追加する場合は上のようにスプレッドし、処理しなかったパスを`tsumugi.fetch`へ渡します

## トークンの設定

認証はfail-closedです。設定するまでREST APIもダッシュボードも404を返します
ローカルではinitが生成した`.dev.vars`の`TSUMUGI_TOKEN`が利用されますが、本番環境においてはSecret経由での注入を推奨します。

```bash
pnpm wrangler secret put TSUMUGI_TOKEN
```

## 動作確認

```bash
pnpm wrangler dev
```

`/enqueue`にアクセスするとジョブIDが返ります
`/`を開くとダッシュボードが表示されます。トークンを入力すると一覧が表示されます

## 次に読むもの

- [Performer](/guide/performer): ジョブの中身の書きかた
- [ジョブの投入](/guide/enqueue): 予約実行、優先度、重複排除
- [実行の制御](/guide/execution): 状態、リトライ、流量制御、実行保証
