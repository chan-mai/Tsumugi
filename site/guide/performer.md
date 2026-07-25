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

bindingは`WorkerEntrypoint`と同様にコンストラクタで受け取るため、`this.env`から参照できます

## 登録簿

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
| `spawn`          | DAGのノードとして実行中に子ノードを追加する関数      |

at-least-onceでは同じジョブが2回実行される場合があるため、外部への副作用は`idempotencyKey`を使って冪等にしてください

`signal`は協調的な中断の要求です
中断に応じないperformerは実行を継続するため、中断させる処理には`signal`を渡す必要があります

`spawn`の使用方法は[DAG(flowとrun)](/guide/flow)を参照してください

## 失敗の通知

例外をthrowすると失敗として扱われ、Durable Objectがリトライの要否を判断します
戻り値を返した場合は成功です

```ts
class ChargeCard extends Performer<{ customerId: string; amountJpy: number }, void, { concurrencyKey: true }, Env> {
  async perform(payload: { customerId: string; amountJpy: number }): Promise<void> {
    const res = await this.env.PAYMENT.charge(payload);
    if (!res.ok) throw new Error(`決済に失敗: ${res.status}`);
  }
}
```

発生した例外のメッセージは試行履歴に保存され、ダッシュボードの詳細画面で確認できます
本文は2,000文字で打ち切られ、1ジョブあたり20件まで保持されます

## キーを必須にする

第3型引数に`{ concurrencyKey: true }`または`{ uniqueKey: true }`を指定すると、そのperformerへの投入時にキーの指定が必須になります

```ts
class ChargeCard extends Performer<Payload, void, { concurrencyKey: true }, Env> {}
```

キーの導出をperformer側の関数に任せない理由は、Durable Objectとperformerが別のisolateで動作するためです
Durable Objectの内部で利用者の関数を実行できないため、呼び出し側が文字列として渡します
Durable Objectはキーの内容を解釈しないため、追加のRPCとレイテンシは発生しません

::: warning 現状の制約
この必須化が適用されるのは`JobQueue<M>`型を経由して呼び出す場合のみです
`enqueue(env, input)`と`createClient()`が受け取るのは`EnqueueInput`で、`binding`は`string`、`payload`は`unknown`のため、キーの渡し忘れも型エラーになりません

`JobQueue<M>`は型定義としてexportされていますが、この型を返すランタイムAPIは現時点でありません
型による強制を適用するには、利用側で`JobQueue<M>`に適合するラッパーを用意する必要があります
:::

## 別Workerへの配置

performerはservice binding越しに別のWorkerへ配置できます
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

呼び出し側の登録簿には、クラスの代わりに`remote()`を指定します

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

ローカルのperformerとリモートのperformerは同じ登録簿に混在できます
リモートのperformerでは`spawn`を使用できません

### リモートでの制約

RPCの引数は`AbortSignal`に対応していないため、`RemoteJobContext`には`signal`がありません
タイムアウト時は呼び出し側が待機を打ち切るだけで、リモート側の処理は継続します

中断が必要な処理はローカルに配置してください
呼び出し中のみ有効な参照をRPCで渡さないため、`spawn`も同じ理由で提供していません

## テスト

`tsumugi/testing`はDurable ObjectとQueuesを起動せずにperformerを呼び出します

```ts
import { createTestContext, runPerformer } from 'tsumugi/testing';

const result = await runPerformer(new SendWelcome(env), { userId: 'u_1' });

if (result.ok) console.log(result.value);
else console.error(result.error);
```

`runPerformer`は例外を再送出せず、結果として返します
本番環境では例外がリトライの判断に使われるため、例外の発生有無を同じ形式で扱えます

### 実行文脈を差し替える

```ts
const ctx = createTestContext({ attempt: 3 });
await runPerformer(new SendWelcome(env), payload, ctx);
```

`signal`は実際の`AbortController`から取得するため、中断に対応するperformerも検証できます

```ts
const ctx = createTestContext();
const running = runPerformer(new SlowJob(env), payload, ctx);

ctx.abort();
await running;
```

### スケジューラとバックオフ

判断ロジックは時刻と乱数を引数で受け取る純粋関数であるため、fake timersを使わずに検証できます

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
