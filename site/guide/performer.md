---
title: Performer
description: ジョブの処理を定義するPerformerの実行コンテキスト, 失敗とリトライ, 別Workerへの配置, テストについて
publishedAt: 2026-07-22
updatedAt: 2026-10-25
---

# Performer

ジョブの処理は、`Performer`を継承したクラスとして定義します。

## 基本形

```ts
import { Performer, type JobContext } from 'tsumugi/performer';

export class SendMail extends Performer<{ to: string; subject: string }, void, {}, Env> {
  async perform(payload: { to: string; subject: string }, ctx: JobContext): Promise<void> {
    const remaining = ctx.deadlineAt - Date.now();
    await fetch('https://api.example.com/mail', {
      method: 'POST',
      body: JSON.stringify(payload),
      // 期限超過時は即中断
      signal: remaining > 0 ? AbortSignal.timeout(remaining) : AbortSignal.abort(),
    });
  }
}
```

型引数は、順にpayload, 戻り値, 必須キーの宣言, `Env`です。
performer内では、`this.env`でWorkerのbindingを参照します。

## binding名

binding名は、Workerのエントリからexportした名前です。
`export class SendMail`の場合、binding名は`SendMail`となり、別途登録する必要はありません。

```ts
// src/index.ts
export { SendMail } from './performers/send-mail.js';
```

`defineTsumugi`の`performers`には、performerをまとめたモジュールをそのまま渡します。
bindingごとのpayloadと必須キーの型は、この`performers`から導出されます。
`performers`のキーは、Workerのエントリからexportした名前と一致させてください。

```ts
import * as performers from './performers/index.js';

export * from './performers/index.js';

const tsumugi = defineTsumugi({ performers, /* ... */ });
```

binding名を別名にする場合は、performerをまとめてexportするファイルで別名を付けてください。

```ts
// src/performers/index.ts
export { SendMail as MAIL } from './send-mail.js';
```

Workerのエントリで別名を付けると、実行時のbinding名は`MAIL`になります。
このとき、`performers`のキーは`SendMail`のままなので、両者が一致しません。
別名はWorkerのエントリでは付けないでください。

```ts
// src/index.ts
// 実行時のexportのみ変更, 型の上のbinding名は不一致
export { SendMail as MAIL } from './performers/send-mail.js';
```

## 実行コンテキスト

`perform`の第2引数には、`JobContext`が渡されます。

| フィールド | 内容 |
| --- | --- |
| `jobId` | ジョブID |
| `attempt` | 試行回数。初回は1 |
| `idempotencyKey` | ジョブごとに一定の値。再実行でも同じ値 |
| `deadlineAt` | タイムアウトの時刻。epochミリ秒 |
| `heartbeat` | 実行中であることを報告する関数 |
| `log` | 処理途中のメッセージを保存する非同期関数 |
| `traceparent` | 投入時に指定したトレース情報。未指定の場合は`null` |
| `spawn` | 実行中のFlowのノードに子ノードを追加する関数 |
| `fail` | 失敗した試行の再試行可否を指定する関数(使い方は「再試行の指定」) |

`at-least-once`では、同じジョブが複数回実行されることを前提にしてください。
外部への副作用は、`idempotencyKey`を利用して冪等性を担保します。

### タイムアウトによる中断

処理をタイムアウトで中断する場合は、`deadlineAt`から`AbortSignal`を作成し、処理に渡します。
期限を過ぎている場合は、`AbortSignal.abort()`を使用してください。

```ts
const remaining = ctx.deadlineAt - Date.now();
const signal = remaining > 0 ? AbortSignal.timeout(remaining) : AbortSignal.abort();
```

Tsumugiは、期限を過ぎたperformerの実行を自動的に停止しません。
`deadlineAt`を用いて中断を実装しないperformerは、期限経過後も実行を継続することがあります。

### heartbeat

所要時間が入力によって大きく変わる処理では、`timeoutMs`を最長の所要時間に合わせて設定する必要があります。
`ctx.heartbeat()`を呼び出すと、タイムアウトの起点が最後の報告された時刻に更新されます。
そのため、`timeoutMs`は報告の間隔を基準にした値で設定してください。

```ts
class Import extends Performer<{ rows: string[] }, void, {}, Env> {
  async perform(payload: { rows: string[] }, ctx: JobContext): Promise<void> {
    for (const [index, row] of payload.rows.entries()) {
      await store(row);
      await ctx.heartbeat((index + 1) / payload.rows.length);
    }
  }
}
```

引数の進捗は、0以上1以下の数値です。
範囲外の値は丸められ、数値以外の値は進捗なしの報告として扱われます。
報告した進捗は、ダッシュボードのジョブの詳細に表示されます。
前回の報告から5秒以内の呼び出しでは、報告が送信されません。
報告の失敗は、例外として通知されません。
戻り値は`{ cancelRequested: boolean }`で、取り消しが要求されているかどうかを示す値です。
一度`true`になった後は、以降の呼び出しの戻り値も`true`です。
取り消しの動作の詳細は、[実行中の取り消し](/guide/execution#実行中の取り消し)の節にあります。

### ログ

`ctx.log(message)`は、処理途中のメッセージを保存します。
呼び出しには`await`が必要です。

```ts
await ctx.log('Import started');
await importRows(payload.rows);
await ctx.log('Import completed');
```

ダッシュボードは、保存したログをジョブの詳細に試行回数、記録時刻、本文とともに表示します。
performerがその後に異常終了した場合も、保存したログは削除されません。
保存されるログは、1ジョブあたり最新の20件です。
本文は、JavaScriptの文字列長で2,000文字までです。
超過した部分は切り捨てられます。
前回の保存から1秒以内の呼び出しでは、ログは保存されません。
保存に失敗した場合は、`console.error`へ出力され、ジョブの処理は続行します。

### トレース情報

`ctx.traceparent`は、投入時に指定した`traceparent`の値で、未指定の場合は`null`です。
リトライ時も、投入時と同一の値です。
トレースのSDKを使用する場合は、`ctx.traceparent`を親のコンテキストとして、spanを作成する必要があります。
投入時に指定する形式と`spawn`の使用方法は、それぞれ[ジョブの投入](/guide/enqueue#トレース情報)と[Flow](/guide/flow#perform内からのノード追加)を参照してください。

## 失敗とリトライ

ジョブが失敗した場合、例外が送出されます。
試行回数が上限に達していないときは、リトライが実行されます。

```ts
class ChargeCard extends Performer<{ customerId: string; amountJpy: number }, void, { concurrencyKey: true }, Env> {
  async perform(payload: { customerId: string; amountJpy: number }): Promise<void> {
    const res = await this.env.PAYMENT.charge(payload);
    if (!res.ok) throw new Error(`payment failed: ${res.status}`);
  }
}
```

例外のメッセージは試行履歴に保存され、ダッシュボードはジョブの詳細に試行履歴を表示します。
保存の上限は、メッセージが2,000文字、試行履歴が1ジョブあたり20件です。
戻り値が8,192文字を超える場合や、直列化できない場合、戻り値は保存されません。
Flowのノードでの扱いは、[Flow](/guide/flow#制約)を参照してください。

### 再試行の指定

`ctx.fail()`を呼び出した後に例外を送出すると、その試行の後続リトライに`ctx.fail()`で指定した内容が適用されます。
`{ retry: false }`を指定した場合、試行回数が上限に達していなくてもジョブはリトライされず、`FAILED`へ遷移します。
この指定は、再試行しても結果が変わらない失敗に対して使用してください。

```ts
class SyncUser extends Performer<{ userId: string }, void, {}, Env> {
  async perform(payload: { userId: string }, ctx: JobContext): Promise<void> {
    const res = await fetch(`https://api.example.com/users/${payload.userId}`);
    if (res.status === 404) {
      await ctx.fail({ retry: false });
      throw new Error(`user not found: ${payload.userId}`);
    }
  }
}
```

`{ retryAt }`にepochミリ秒を指定すると、その試行に限り、`backoff`で算出した間隔ではなく、指定した時刻に再試行されます。
次の例は、`Retry-After`ヘッダの値(秒数またはHTTP-date)を時刻に変換します。

```ts
if (res.status === 429) {
  const header = res.headers.get('Retry-After') ?? '';
  const date = Date.parse(header);
  // 解釈不能時は60秒後
  const retryAt = /^\d+$/.test(header)
    ? Date.now() + Number(header) * 1_000
    : Number.isNaN(date)
      ? Date.now() + 60_000
      : date;
  await ctx.fail({ retryAt });
  throw new Error('rate limited');
}
```

`retryAt`を指定しても、その試行は試行回数に含まれます。
`maxAttempts`に達している場合、ジョブは`FAILED`へ遷移します。
指定した時刻が期限(`expiresAt`)より後の場合、ジョブは`CANCELLED`へ遷移します。
過去の時刻を指定した場合は、直ちに再試行の対象となります。
`ctx.fail()`の指定は、throwで終了した試行にのみ適用されます。
throwせずに`perform`が終了した場合、`ctx.fail()`を呼んでいてもジョブは完了します。
1回の試行で`ctx.fail()`を複数回呼び出した場合、最後の指定が有効です。
不正な形式の値を`ctx.fail()`に渡すと、その呼び出しで例外が発生します。

## キーの必須化

第3型引数に`{ concurrencyKey: true }`または`{ uniqueKey: true }`を指定したperformerでは、ジョブの投入時にキーの指定が必須となります。

```ts
class ChargeCard extends Performer<Payload, void, { concurrencyKey: true }, Env> {}
```

キーは、ジョブの投入時に文字列として渡します。
Tsumugiは、performer側でキーを導出する関数を定義する仕組みを提供していません。
`tsumugi.enqueue`および`tsumugi.jobs(env)`では、キーを指定しない場合、コンパイル時にエラーが発生します。

```ts
await tsumugi.enqueue(env, { binding: 'CHARGE', payload, concurrencyKey: 'customer:c1' });
await tsumugi.jobs(env).enqueue('CHARGE', payload, { concurrencyKey: 'customer:c1' });
```

::callout{type="warning"}
`createClient()`には、キーの必須化が適用されません。
詳細は[投入方法](/guide/enqueue#投入方法)を参照してください。
::

## 別Workerへの配置

performerは、Service Bindingで接続した別のWorkerに配置した場合でも、Tsumugiから実行されます。

```ts
// performerを配置するWorker
import { Performer, type JobContext } from 'tsumugi/performer';

export class SendMail extends Performer<{ to: string; subject: string }, void, {}, Env> {
  async perform(payload: { to: string; subject: string }, ctx: JobContext): Promise<void> {
    // ...
  }
}

// WorkerEntrypointの名前付きexportに加えてdefaultも必要
export default {
  async fetch(): Promise<Response> {
    return new Response('performer only', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

呼び出し側のwrangler.jsoncには、binding名とentrypointを対応させるService Bindingを設定する必要があります。

```jsonc
"services": [
  { "binding": "MAIL", "service": "my-mailer", "entrypoint": "SendMail" },
],
```

呼び出し側の`performers`には、クラスの代わりに`remote()`を指定してください。
同じWorkerのperformerと別Workerのperformerは、1つの`performers`に混在させる構成にも対応しています。

```ts
import { remote } from 'tsumugi';
import type { SendMail } from 'my-mailer';

const performers = { ...local, MAIL: remote<SendMail>() };
```

### 別Workerに配置した場合の制約

別Workerに配置されたperformerでは、`ctx.spawn`と`ctx.fail`の呼び出しに`await`が必要です。
`ctx.spawn`を`await`せずに`perform`が終了すると、子ノードの追加は反映されません。
`ctx.fail`を`await`せずに例外をthrowした場合も、指定は反映されない可能性があります。

```ts
await ctx.spawn('child', 'MAIL', payload);
```

`spawn`で追加した子ノードは、`perform`の完了後に作成されます。
`spawn`の呼び出し時点では、子ノードは実行されません。

## テスト

`tsumugi/testing`の`runPerformer`は、ジョブを投入せずにperformerを直接呼び出します。
`Performer`のコンストラクタは、`WorkerEntrypoint`と同じ`(ctx, env)`の2引数を取ります。

```ts
import { createTestContext, runPerformer } from 'tsumugi/testing';

declare const ctx: ExecutionContext;
declare const env: Env;

const result = await runPerformer(new SendWelcome(ctx, env), { userId: 'u_1' });

if (result.ok) console.log(result.value);
else console.error(result.error);
```

`this.env`を使用しないperformerでは、`runPerformer`は`perform`を持つ通常のオブジェクトも受け付けます。
`runPerformer`は例外を再送出せず、成功と失敗のどちらも同じ形式の結果を戻り値とします。
`createTestContext()`の戻り値であるコンテキストは、`ctx.fail()`に渡された指定を、呼び出し順に`fails`へ記録します。

### 実行コンテキストの差し替え

`createTestContext`に値を指定すると、`runPerformer`に渡す実行コンテキストの項目を差し替えられます。
次の例は、試行回数を3回目に設定します。

```ts
const ctx = createTestContext({ attempt: 3 });
await runPerformer(performer, payload, ctx);
```

期限に対するperformerの動作を検証する場合は、`deadlineAt`に過去の時刻または近い将来の時刻を指定します。

```ts
const ctx = createTestContext({ deadlineAt: Date.now() + 50 });
await runPerformer(performer, payload, ctx);
```

### 投入から実行までのテスト

ジョブの投入から実行までの一連の流れを検証する場合は、`@cloudflare/vitest-pool-workers`を利用してください。
`tsumugi/testing`は、この範囲のテストを対象としていません。
