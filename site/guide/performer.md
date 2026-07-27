# Performer

ジョブの処理内容は`Performer`を継承したクラスとして記述します

## 基本形

```ts
import { Performer, type JobContext } from 'tsumugi/performer';

export class SendMail extends Performer<{ to: string; subject: string }, void, {}, Env> {
  async perform(payload: { to: string; subject: string }, ctx: JobContext): Promise<void> {
    const remaining = ctx.deadlineAt - Date.now();
    await fetch('https://api.example.com/mail', {
      method: 'POST',
      body: JSON.stringify(payload),
      // AbortSignal.timeoutは負の値を受け付けないため、期限を過ぎていれば即座に中断する
      signal: remaining > 0 ? AbortSignal.timeout(remaining) : AbortSignal.abort(),
    });
  }
}
```

型引数は順に、ペイロード、戻り値、必須キーの宣言、`Env`です

bindingは`WorkerEntrypoint`と同様にコンストラクタで受け取るため、`this.env`から参照可能です

## binding名

binding名はWorkerのエントリからexportした名前で解決され、`export class SendMail`と書けばbinding名は`SendMail`になり、別途の登録は不要です

```ts
// src/index.ts
export { SendMail } from './performers/send-mail.js';
```

`defineTsumugi`の`performers`には、performerをまとめたモジュールをそのまま渡します
これはペイロードと必須キーの型を引くためのもので、実行時の解決には使いません

```ts
import * as performers from './performers/index.js';

export * from './performers/index.js';

const tsumugi = defineTsumugi({ performers, /* ... */ });
```

別名を付ける場合はバレルのexportで変えます
実行時の解決先と`performers`のキーが同じ1箇所から決まるため、両者がずれません

```ts
// src/performers/index.ts
export { SendMail as MAIL } from './send-mail.js';
```

Workerのエントリでのみ別名を付けると、実行時は`MAIL`で解決される一方で`performers`のキーは`SendMail`のまま残り、型の上のbinding名と一致しなくなります

```ts
// src/index.ts
// 実行時のexportだけが変わるので、これだけでは足りない
export { SendMail as MAIL } from './performers/send-mail.js';
```

## 実行文脈

`perform`の第2引数に`JobContext`が渡されます

| フィールド       | 内容                                                 |
| ---------------- | ---------------------------------------------------- |
| `jobId`          | `<binding>#<shard>:<localId>`形式のジョブID          |
| `attempt`        | 1始まりの試行回数                                    |
| `idempotencyKey` | ジョブ単位で一定の値、再実行でも同じ値               |
| `deadlineAt`     | タイムアウトが切れる時刻、epochミリ秒               |
| `spawn`          | Flowのノードとして実行中に子ノードを追加する関数     |

at-least-onceでは同じジョブが2回実行される場合があるため、外部への副作用は`idempotencyKey`を使って冪等にしてください

中断が必要な処理には`deadlineAt`から`AbortSignal`を組み立てて渡します
`AbortSignal`はRPCの引数として渡せない制約があるため、Tsumugiが渡すのは時刻のみです

`AbortSignal.timeout`は負の値を受け付けないため、期限を過ぎている場合は`AbortSignal.abort()`を使います

```ts
const remaining = ctx.deadlineAt - Date.now();
const signal = remaining > 0 ? AbortSignal.timeout(remaining) : AbortSignal.abort();
```

中断は協調的な要求であり、応じないperformerは期限を過ぎても実行を継続する可能性があります。

`spawn`の使用方法は[Flow](/guide/flow)を参照してください

## 失敗の通知

例外をthrowすると失敗として扱われ、試行回数が残っていればリトライされます
戻り値を返した場合は成功です

```ts
class ChargeCard extends Performer<{ customerId: string; amountJpy: number }, void, { concurrencyKey: true }, Env> {
  async perform(payload: { customerId: string; amountJpy: number }): Promise<void> {
    const res = await this.env.PAYMENT.charge(payload);
    if (!res.ok) throw new Error(`payment failed: ${res.status}`);
  }
}
```

発生した例外のメッセージは試行履歴に保存され、ダッシュボードの詳細画面に表示されます
本文は2,000文字で打ち切られ、1ジョブあたり20件まで保持されます

## キーを必須にする

第3型引数に`{ concurrencyKey: true }`または`{ uniqueKey: true }`を指定すると、そのperformerへの投入時にキーの指定が必須になります

```ts
class ChargeCard extends Performer<Payload, void, { concurrencyKey: true }, Env> {}
```

キーは投入時に文字列として渡します。performer側の関数で導出する形は取りません

::: warning 現状の制約
この必須化が適用されるのは`JobQueue<M>`型を経由して呼び出す場合のみです
`enqueue(env, input)`と`createClient()`が受け取るのは`EnqueueInput`で、`binding`は`string`、`payload`は`unknown`のため、キーの渡し忘れも型エラーになりません

`JobQueue<M>`は型定義としてexportされていますが、この型を返すランタイムAPIは現時点でありません
型による強制を適用するには、利用側で`JobQueue<M>`に適合するラッパーを用意する必要があります
:::

## 別Workerへの配置

performerはservice binding越しに別のWorkerへの配置が可能です

```ts
// 相手側のWorker
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

wrangler.jsoncのservice bindingで、binding名とentrypointを対応させます

```jsonc
"services": [
  { "binding": "MAIL", "service": "my-mailer", "entrypoint": "SendMail" },
],
```

呼び出し側の`performers`には、クラスの代わりに`remote()`を置きます
相手のクラスは別Workerにあるためimportできず、型を運ぶためだけに指定します

```ts
import { remote } from 'tsumugi';
import type { SendMail } from 'my-mailer';

const performers = { ...local, MAIL: remote<SendMail>() };
```

同一Workerのperformerと別Workerのperformerは混在可能です

### 別Worker時の制約

`spawn`が要求した子ノードは`perform`の完了報告に同梱されてから処理されます。呼び出した時点では実行は始まりません

別Workerでは`ctx.spawn`がRPCの呼び出しになるため、`await`が必要になります。`await`せずに`perform`が終わると、要求が完了報告に載らないまま失われます

```ts
await ctx.spawn('child', 'MAIL', payload);
```

## テスト

`tsumugi/testing`はDurable ObjectとQueuesを起動せずにperformerを呼び出します

```ts
import { createTestContext, runPerformer } from 'tsumugi/testing';

const result = await runPerformer(new SendWelcome(env), { userId: 'u_1' });

if (result.ok) console.log(result.value);
else console.error(result.error);
```

`runPerformer`は例外を再送出せず、成功と失敗を同じ形式で返します

### 実行文脈を差し替える

```ts
const ctx = createTestContext({ attempt: 3 });
await runPerformer(new SendWelcome(env), payload, ctx);
```

`deadlineAt`を過去や近い将来に置くと、期限に対する振る舞いを検証できます

```ts
const ctx = createTestContext({ deadlineAt: Date.now() + 50 });
await runPerformer(new SlowJob(env), payload, ctx);
```

### スケジューラとバックオフ

時刻と乱数は引数で渡すため、fake timersは不要です

```ts
import { fixedClock, nextAttempt, schedule } from 'tsumugi/testing';

// 3回目の再試行の時刻
nextAttempt({ attempts: 3, maxAttempts: 5, backoff, now: Date.now() });

// このポリシーで投入される件数
schedule({ now, jobs, policy, bucket });
```

### Durable Objectを経由するテスト

Durable ObjectとQueuesを経由した動作を検証する場合は`@cloudflare/vitest-pool-workers`が必要です
`tsumugi/testing`はこの範囲を扱いません
