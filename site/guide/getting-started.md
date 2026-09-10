# Getting Started

## 用意するもの

- Workers Paidプランが有効なCloudflareアカウント
- 2025-11-17以降の`compatibility_date`

## インストール

```bash
pnpm create cloudflare@latest my-jobs --type=hello-world
cd my-jobs
pnpm add tsumugi
```

## セットアップ


```bash
npx tsumugi init
```

新しいプロジェクトでは次の状態になります。

- D1とQueuesが作成済み
- `wrangler.jsonc`が生成済み。`wrangler d1 create`が出力した`database_id`は転記済み
- `src/index.ts`と`src/performers/`と`.dev.vars`が生成済み
- 一覧と検索が使用するD1のテーブルのマイグレーションが適用済み

途中の手順が失敗した場合は警告が表示され、再実行するコマンドが案内されます。

既にwrangler設定がある場合は書き換えず、追記する箇所が出力されます。
この場合、マイグレーションは自動で適用されないため、編集後に出力される手順に沿って適用してください。
オプションと生成物の詳細は[CLI](/reference/cli)を参照してください。

`TSUMUGI_METRICS`のbindingは任意であり、設定しない場合はメトリクスが記録されませんが、その他の動作に影響はありません。
Flowを利用する場合に限り、追加のbindingが必要です。
詳細は[設定](/reference/config)と[Flow](/guide/flow)を参照してください。

::: warning
Tsumugiを更新した場合はマイグレーションの再適用が必要です。マイグレーションはバージョンによって追加されます。
未適用のマイグレーションがある場合、REST APIは503になり、応答本文に未適用のファイル名が含まれます。
:::

## performer

ジョブの処理内容はperformerに記述します。init時に生成される`src/performers/hello.ts`が最小構成の例です。

```ts
// src/performers/hello.ts
import { Performer } from 'tsumugi/performer';

export class Hello extends Performer<{ name: string }, void, {}, Env> {
  async perform(payload: { name: string }): Promise<void> {
    console.log(`hello, ${payload.name}`);
  }
}
```

`perform`の中身とpayloadの型を目的に合わせて書き換えてください。

performerの追加はadd-performerで行います。

```bash
npx tsumugi add-performer send-mail
```

ファイルの生成と、まとめてexportするファイル(`src/performers/index.ts`)への追記が行われます。
この名称がbinding名として利用され、payloadの型も決定されます。

```ts
// src/performers/index.ts
export { Hello } from './hello.js';
export { SendMail } from './send-mail.js';
```

## Worker

initが生成する`src/index.ts`は次の形です。
performerをWorkerのトップレベルからexportします。binding名はexportした名前がそのまま利用されます。

```ts
import { bearerAuth, defineTsumugi } from 'tsumugi';
import { ui } from 'tsumugi/ui';
import * as performers from './performers/index.js';

export * from './performers/index.js';

const tsumugi = defineTsumugi({
  performers,
  // secretから取得する, 直書きするとリポジトリとバンドルの両方に残る
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

`performers`はペイロードと必須キーの型を導出するためのもので、実行時の解決には利用されません。`defineTsumugi`の引数に渡す必要はありませんが、型の解決のためにexportした名前と一致させる必要があります。

`tsumugi.enqueue`では、bindingからpayloadと必須キーの型が決定されます。
投入経路についての詳細は[ジョブの投入](/guide/enqueue#paths)を参照してください。

`defineTsumugi`の戻り値には、`fetch`と`queue`と`scheduled`のほかに、投入とFlowの開始を行う関数が含まれます。
全体は[設定](/reference/config#definetsumugi)を参照してください。

## トークンの設定

認証を設定するまで、REST APIもダッシュボードも404を返します。
ローカルではinitが生成した`.dev.vars`の`TSUMUGI_TOKEN`が使用されますが、本番環境ではSecretとして設定することを推奨します。

```bash
pnpm wrangler secret put TSUMUGI_TOKEN
```

## 動作確認

```bash
pnpm wrangler dev
```


## 次に読むもの

- [Performer](/guide/performer): ジョブの中身の書きかた
- [ジョブの投入](/guide/enqueue): 予約実行、優先度、重複排除
- [実行の制御](/guide/execution): 状態、リトライ、流量制御、実行保証
