---
title: Getting Started
publishedAt: 2026-07-22
updatedAt: 2026-10-25
---

# Getting Started

## 前提条件

Workers Paidプランが有効なCloudflareアカウントが必要です。
`compatibility_date`は2025-11-17以降に設定してください。

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

新しいプロジェクトで`init`を実行すると、必要なCloudflareのリソースを作成し、`wrangler.jsonc`, `src/index.ts`, `src/performers/`, `.dev.vars`を生成します。
最後にデータベースのマイグレーションを適用して終了します。
途中で失敗した場合は、警告とともに再実行するコマンドを出力します。

wranglerの設定ファイルが既に存在する場合、`init`は設定ファイルを書き換えず、追記すべき内容を出力します。
このときはマイグレーションも適用されません。
設定ファイルを編集した後に、出力された手順でマイグレーションを適用してください。
オプションと生成されるファイルは、[CLI](/reference/cli)で説明しています。

`TSUMUGI_METRICS`のbindingは任意です。
設定しない場合、メトリクスは記録されませんが、ほかの動作は変わりません。
Flowと定期実行を使う場合は、追加のbindingを設定してください。
設定の内容は、[wranglerのbinding](/reference/config#wranglerのbinding), [Flowの設定](/guide/flow#設定), [定期実行の設定](/guide/schedule#設定)に記載しています。

::callout{type="warning"}
Tsumugiを更新したら、マイグレーションを再適用してください。
新しいバージョンでは、マイグレーションが追加されていることがあります。
未適用のマイグレーションが残っている場合、REST APIは503で応答し、その本文に未適用のファイル名を含めます。
::

## performer

ジョブの処理は、performerとして定義します。
`init`が生成する`src/performers/hello.ts`が、最小の例です。
`perform`の処理とpayloadの型を、用途に合わせて書き換えてください。

```ts
// src/performers/hello.ts
import { Performer } from 'tsumugi/performer';

export class Hello extends Performer<{ name: string }, void, {}, Env> {
  async perform(payload: { name: string }): Promise<void> {
    console.log(`hello, ${payload.name}`);
  }
}
```

performerを追加するときは、`add-performer`を実行してください。

```bash
npx tsumugi add-performer send-mail
```

performerのファイルが生成され、`src/performers/index.ts`にexport行が1行追記されます。

```ts
// src/performers/index.ts
export { Hello } from './hello.js';
export { SendMail } from './send-mail.js';
```

## Worker

`init`は、次の内容の`src/index.ts`を生成します。
performerはWorkerのエントリポイントからexportし、その名前がbinding名として使用されます。
binding名の規則については、[binding名](/guide/performer#binding名)で説明しています。

```ts
import { bearerAuth, defineTsumugi } from 'tsumugi';
import { ui } from 'tsumugi/ui';
import * as performers from './performers/index.js';

export * from './performers/index.js';

const tsumugi = defineTsumugi({
  performers,
  // secretから取得, 直書きはリポジトリとバンドルに残存
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

`defineTsumugi`の戻り値には、`fetch`, `queue`, `scheduled`のハンドラに加えて、ジョブを投入する関数とFlowを開始する関数が含まれます。
戻り値の一覧は[設定](/reference/config#definetsumugi)に、投入方法ごとの違いは[ジョブの投入](/guide/enqueue#投入方法)に記載しています。

## トークンの設定

`auth`を指定しない場合、`tsumugi.fetch`はすべてのリクエストに対して404で応答します。
上記の例では、`bearerAuth`を使用しています。ローカル環境では`.dev.vars`に定義された`TSUMUGI_TOKEN`を参照します。
本番環境では、以下のコマンドを実行してSecretを登録してください。

```bash
pnpm wrangler secret put TSUMUGI_TOKEN
```

## 動作確認

```bash
pnpm wrangler dev
```

`/enqueue`にアクセスするとHelloジョブが投入され、ジョブIDを含む`{ "id": "..." }`のレスポンスが届きます。
投入したジョブは、ダッシュボード(`/`)の一覧に表示されます。
トークンの入力を求められたら、`.dev.vars`の`TSUMUGI_TOKEN`の値を入力してください。
`init`が生成した直後の値は`dev-token`です。

## 次に参照するページ

- [Performer](/guide/performer): ジョブの処理を定義します。
- [ジョブの投入](/guide/enqueue): 予約実行, 優先度, 重複排除
- [実行の制御](/guide/execution): ジョブの状態管理, リトライ設定, 実行量の制限, 実行保証について説明します。
