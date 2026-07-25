# Performer

ジョブの処理内容は`Performer`を継承したクラスとして記述します

## 基本形

```ts
import { Performer, type JobContext } from 'tsumugi/performer';

class SendMail extends Performer<{ to: string; subject: string }, void, {}, Env> {
  async perform(payload: { to: string; subject: string }, ctx: JobContext): Promise<void> {
    await fetch('https://api.example.com/mail', {
      method: 'POST',
      body: JSON.stringify(payload),
      signal: ctx.signal,
    });
  }
}
```

型引数は順に、ペイロード、戻り値、必須キーの宣言、`Env`です

bindingは`WorkerEntrypoint`と同様にコンストラクタで受け取るため、`this.env`から参照可能です

## performers

binding名とperformerの対応は`defineTsumugi`の`performers`に記述します
この1箇所に記述すれば、wranglerのservice bindingの追加も型引数の明示も不要です

```ts
const tsumugi = defineTsumugi<Env>({
  performers: { MAIL: SendMail, CHARGE: ChargeCard },
  // ...
});
```

## 実行文脈

`perform`の第2引数に`JobContext`が渡されます

| フィールド       | 内容                                                 |
| ---------------- | ---------------------------------------------------- |
| `jobId`          | `<binding>#<shard>:<localId>`形式のジョブID          |
| `attempt`        | 1始まりの試行回数                                    |
| `idempotencyKey` | ジョブ単位で一定の値、再実行でも同じ値               |
| `signal`         | タイムアウト時にabortされる`AbortSignal`             |
| `spawn`          | Flowのノードとして実行中に子ノードを追加する関数     |

at-least-onceでは同じジョブが2回実行される場合があるため、外部への副作用は`idempotencyKey`を使って冪等にしてください

`signal`は協調的な中断の要求です
中断に応じないperformerは実行を継続するため、中断させる処理には`signal`を渡す必要があります

`spawn`の使用方法は[Flow](/guide/flow)を参照してください

## 失敗の通知

例外をthrowすると失敗として扱われ、試行回数が残っていればリトライされます
戻り値を返した場合は成功です

```ts
class ChargeCard extends Performer<{ customerId: string; amountJpy: number }, void, { concurrencyKey: true }, Env> {
  async perform(payload: { customerId: string; amountJpy: number }): Promise<void> {
    const res = await this.env.PAYMENT.charge(payload);
    if (!res.ok) throw new Error(`決済に失敗: ${res.status}`);
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
その場合は`RemotePerformer`を継承します

```ts
// 相手側のWorker
import { RemotePerformer, type RemoteJobContext } from 'tsumugi/performer';

export class SendMail extends RemotePerformer<{ to: string; subject: string }, void, {}, Env> {
  async perform(payload: { to: string; subject: string }, ctx: RemoteJobContext): Promise<void> {
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

呼び出し側の`performers`には、クラスの代わりに`remote()`を指定します

```ts
import { remote } from 'tsumugi';

const performers = { HELLO: Hello, MAIL: remote<SendMail>('MAIL_SERVICE') };
```

wrangler.jsoncではentrypointにクラス名を指定します

```jsonc
"services": [
  { "binding": "MAIL_SERVICE", "service": "my-mailer", "entrypoint": "SendMail" },
],
```

ローカルのperformerとリモートのperformerは同じ`performers`に混在可能です

### リモートでの制約

RPCの引数は`AbortSignal`に対応していないため、`RemoteJobContext`には`signal`がありません
タイムアウト時は呼び出し側が待機を打ち切るだけで、リモート側の処理は継続します
中断が必要な処理はローカルに配置してください

`spawn`も渡されません

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

`signal`は実際の`AbortController`から取得するため、中断に対応するperformerの検証も可能です

```ts
const ctx = createTestContext();
const running = runPerformer(new SlowJob(env), payload, ctx);

ctx.abort();
await running;
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
