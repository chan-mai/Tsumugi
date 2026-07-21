# ジョブの投入

## enqueue

```ts
import { enqueue } from 'tsumugi';

const id = await enqueue(env, {
  binding: 'MAIL',
  payload: { to: 'a@example.com', subject: 'hi' },
});
```

返値はジョブのIDです
`defineTsumugi`が返すオブジェクトにも同じ`enqueue`が用意されているので、`tsumugi.enqueue(env, input)`でも構いません

## enqueueMany

複数件をまとめて入れるときは`enqueueMany`を使います

```ts
const ids = await enqueueMany(env, [
  { binding: 'MAIL', payload: { to: 'a@example.com', subject: 'hi' } },
  { binding: 'MAIL', payload: { to: 'b@example.com', subject: 'hi' } },
]);
```

宛先のDurable Objectごとに集約して1回のRPCにまとめるので、件数が増えても往復は増えません
`enqueue`を逐次で回すと実測78件/秒あたりでDurable Objectの1,000 req/sソフト上限に律速されます

戻り値は入力と同じ並び順です

## オプション

| 名前             | 既定                                        | 内容                                 |
| ---------------- | ------------------------------------------- | ------------------------------------ |
| `priority`       | `0`                                         | 数値優先度、大きいほど先に出る       |
| `maxAttempts`    | `3`                                         | 試行回数の上限                       |
| `backoff`        | 指数、1秒起点、係数2、上限1時間、ジッタあり | リトライ間隔                         |
| `timeoutMs`      | `60000`                                     | 待機を打ち切るまでの時間             |
| `delayMs`        | なし                                        | 実行開始を遅らせる                   |
| `runAt`          | なし                                        | 絶対時刻での予約、`delayMs`とは排他  |
| `guarantee`      | `at-least-once`                             | 実行保証                             |
| `concurrencyKey` | なし                                        | キー単位の直列化に使う               |
| `uniqueKey`      | なし                                        | 重複排除に使う                       |
| `uniqueForMs`    | 24時間                                      | `uniqueKey`の予約を保持する期間      |
| `partitionKey`   | なし                                        | 分割している場合の投入先の決定に使う |

## 予約実行

```ts
// 1時間後
await enqueue(env, { binding: 'MAIL', payload, delayMs: 60 * 60 * 1000 });

// 指定時刻
await enqueue(env, { binding: 'MAIL', payload, runAt: Date.parse('2026-08-01T09:00:00+09:00') });
```

待機はDurable Objectのalarmが管理するので、Queuesの遅延配送の12時間上限には縛られません

## 重複排除

`uniqueKey`を渡すと、同じキーのジョブが既にあるときは新規作成せず既存のジョブIDが返ります

```ts
const id = await enqueue(env, {
  binding: 'SYNC',
  payload: { sku: 'X-1' },
  uniqueKey: 'sku:X-1',
});
```

衝突は異常ではなく正常系として扱います。例外は投げません
呼び出し側が毎回try/catchを書かずに済み、HTTPリクエストのリトライやWebhookの重複配送で二重登録されなくなります

予約は`uniqueForMs`が過ぎると消えるので、それ以降は同じキーでも新しいジョブになります

重複排除の判定はDurable Object内のテーブルで行います
KVには条件付き書き込みの公開APIがなく、「無ければ入れる」を不可分に実行できないためです
Durable Objectはシングルスレッドなので、検査と挿入が追加の仕組みなしで不可分になります

## 直列化

`concurrencyKey`が同じジョブは、`perKeyConcurrency`の上限まで同時に走ります
既定は1なので、同じキーのジョブは1件ずつ順に実行されます

```ts
await enqueue(env, {
  binding: 'CHARGE',
  payload: { customerId: 'c1', amountJpy: 1200 },
  concurrencyKey: 'customer:c1',
});
```

これが正しく効くのはshard数が1のときです
2以上にした場合はshardもそのキーで決めないと保証がエラーにならないまま無効になるので、[shard](/guide/execution#shard)を読んでください

## ジョブID

```
<binding>#<shard>:<localId>
```

例: `MAIL#0:xxxxxxxxxxxxxxxxxxxxxxxx`

どのDurable Objectが保持しているかをIDに含めてあるので、IDからDurable Objectのstubを直接取得できます
グローバルな索引は不要です

その代わり、shard数を後から変えると既存IDの引き先が変わります
古いshardは残す必要があります

## 別Workerから入れる

投入だけを行うWorkerからは`tsumugi/client`を使います
Durable Object実装をバンドルせずに済みます。詳しくは[別Workerからの投入](/guide/client)を参照してください
