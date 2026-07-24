# Performer

ジョブの中身は`Performer`を継承したクラスとして書きます

## 基本の形

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

bindingは`WorkerEntrypoint`と同じくコンストラクタで受け取るので、`this.env`から参照できます

## 登録簿

binding名とperformerの対応は`defineTsumugi`の`performers`に書きます
ここ1箇所に書けば、wranglerのservice bindingも型引数の手書きも不要です

```ts
const tsumugi = defineTsumugi<Env>({
  performers: { MAIL: SendMail, CHARGE: ChargeCard },
  // ...
});
```

## 実行文脈

`perform`の第2引数に`JobContext`が渡ります

| フィールド       | 内容                                        |
| ---------------- | ------------------------------------------- |
| `jobId`          | `<binding>#<shard>:<localId>`の形のジョブID |
| `attempt`        | 1始まりの試行回数                           |
| `idempotencyKey` | ジョブ単位で安定する値、再実行でも同じ      |
| `signal`         | タイムアウト時にabortされる`AbortSignal`    |

at-least-onceでは同じジョブが2回実行され得るので、外部への副作用は`idempotencyKey`で冪等にしておきます

`signal`は協調的な中断の要求にすぎません
応じないperformerは実行を継続するので、中断させたい処理には自分で渡す必要があります

## 失敗の伝えかた

`throw`すれば失敗として扱われ、Durable Objectがリトライの要否を決めます
戻り値を返せば成功です

```ts
class ChargeCard extends Performer<{ customerId: string; amountJpy: number }, void, { concurrencyKey: true }, Env> {
  async perform(payload: { customerId: string; amountJpy: number }): Promise<void> {
    const res = await this.env.PAYMENT.charge(payload);
    if (!res.ok) throw new Error(`決済に失敗: ${res.status}`);
  }
}
```

投げた例外のメッセージは試行履歴に残り、ダッシュボードの詳細画面で確認できます
本文は2,000字で打ち切られ、1ジョブあたり20件まで保持されます

## キーを必須にする

第3型引数に`{ concurrencyKey: true }`や`{ uniqueKey: true }`を書くと、そのperformerへの投入時にキーの指定が必須になります

```ts
class ChargeCard extends Performer<Payload, void, { concurrencyKey: true }, Env> {}
```

キーの導出をperformer側の関数に任せない理由は、Durable Objectとperformerが別isolateだからです
Durable Objectの中でユーザーの関数は実行できないので、呼び出し側が文字列として渡します
Durable Objectは不透明なキーとして扱うだけなので、追加のRPCもレイテンシも発生しません

::: warning 現状の制約
この必須化が働くのは`JobQueue<M>`型を経由して呼び出す場合だけです
`enqueue(env, input)`と`createClient()`が受け取るのは`EnqueueInput`で、`binding`は`string`、`payload`は`unknown`のため、キーの渡し忘れも型エラーになりません

`JobQueue<M>`は型定義としてexportされていますが、この型を返すランタイムAPIは現時点でありません
型による強制を効かせるには、利用側で`JobQueue<M>`に適合するラッパーを自分で用意する必要があります
:::

## 別Workerに置く

performerはservice binding越しの別Workerにも置けます
その場合は`RemotePerformer`を継承します

```ts
// 相手側のWorker
import { RemotePerformer, type RemoteJobContext } from 'tsumugi/performer';

export class SendMail extends RemotePerformer<{ to: string; subject: string }, void, {}, Env> {
  async perform(payload: { to: string; subject: string }, ctx: RemoteJobContext): Promise<void> {
    // ...
  }
}

// WorkerEntrypointの名前付きexportに加えてdefaultも要る
export default {
  async fetch(): Promise<Response> {
    return new Response('performer only', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

呼び出し側の登録簿には、クラスの代わりに`remote()`を置きます

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

### リモートでの制約

RPCの引数は`AbortSignal`に対応していないので、`RemoteJobContext`には`signal`がありません
タイムアウトは呼び出し側が待機を打ち切るだけで、リモート側の処理は継続します

中断が必要な処理はローカルに配置してください

## テストする

`tsumugi/testing`はDurable ObjectもQueuesも起動せずにperformerを呼びます

```ts
import { createTestContext, runPerformer } from 'tsumugi/testing';

const result = await runPerformer(new SendWelcome(env), { userId: 'u_1' });

if (result.ok) console.log(result.value);
else console.error(result.error);
```

`runPerformer`は例外を投げずに結果として返します
本番では例外がそのままリトライの判断になるため、投げたかどうかを同じ形で扱えます

### 実行文脈を差し替える

```ts
const ctx = createTestContext({ attempt: 3 });
await runPerformer(new SendWelcome(env), payload, ctx);
```

`signal`は実物の`AbortController`から取るので、中断に協調するperformerも試せます

```ts
const ctx = createTestContext();
const running = runPerformer(new SlowJob(env), payload, ctx);

ctx.abort();
await running;
```

### スケジューラとバックオフ

判断ロジックは時刻も乱数も引数で受け取る純粋関数なので、fake timersなしで検証できます

```ts
import { fixedClock, nextAttempt, schedule } from 'tsumugi/testing';

// 3回目の再試行がいつになるか
nextAttempt({ attempts: 3, maxAttempts: 5, backoff, now: Date.now() });

// このポリシーで何件動くか
schedule({ now, jobs, policy, bucket });
```

### Durable Objectを絡めたテスト

DOやQueuesの往復まで確かめる場合は`@cloudflare/vitest-pool-workers`が要ります
`tsumugi/testing`はその領域を扱いません
