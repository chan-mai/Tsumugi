# ジョブの投入

## enqueue

```ts
import { enqueue } from 'tsumugi';

const id = await enqueue(env, {
  binding: 'MAIL',
  payload: { to: 'a@example.com', subject: 'hi' },
});
```

戻り値はジョブIDです
`defineTsumugi`が返すオブジェクトにも同じ`enqueue`があるため、`tsumugi.enqueue(env, input)`でも同じ結果になります

## enqueueMany

複数件をまとめて投入する場合は`enqueueMany`を使用します

```ts
const ids = await enqueueMany(env, [
  { binding: 'MAIL', payload: { to: 'a@example.com', subject: 'hi' } },
  { binding: 'MAIL', payload: { to: 'b@example.com', subject: 'hi' } },
]);
```

宛先のDurable Objectごとに集約して1回のRPCにまとめるため、件数が増えてもRPCの回数は増えません
`enqueue`を逐次で呼び出す場合、実測で78件/秒付近でDurable Objectの1,000 req/sソフト上限に到達します

戻り値は入力と同じ並び順です

## オプション

| 名前             | 既定                                        | 内容                                 |
| ---------------- | ------------------------------------------- | ------------------------------------ |
| `priority`       | `0`                                         | 数値優先度、大きいほど先に投入する   |
| `maxAttempts`    | `3`                                         | 試行回数の上限                       |
| `backoff`        | 指数、1秒起点、係数2、上限1時間、ジッタあり | リトライ間隔                         |
| `timeoutMs`      | `60000`                                     | 結果を待つ時間の上限                 |
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

待機はDurable Objectのalarmが管理するため、Queuesの遅延配送の12時間上限は適用されません

## 重複排除

`uniqueKey`を指定すると、同じキーのジョブが既に存在する場合は新規作成せず、既存のジョブIDを返します

```ts
const id = await enqueue(env, {
  binding: 'SYNC',
  payload: { sku: 'X-1' },
  uniqueKey: 'sku:X-1',
});
```

衝突は異常ではなく正常系として扱い、例外は発生しません
呼び出し側でtry/catchが不要になり、HTTPリクエストのリトライやWebhookの重複配送で二重登録されなくなります

予約は`uniqueForMs`の経過後に削除され、それ以降は同じキーでも新しいジョブになります

重複排除の判定はDurable Object内のテーブルで行います
KVには条件付き書き込みの公開APIがなく、「無ければ入れる」を不可分に実行できないためです
Durable Objectはシングルスレッドなので、検査と挿入が追加の仕組みなしで不可分になります

## 直列化

`concurrencyKey`が同じジョブは、`perKeyConcurrency`の上限まで同時に実行されます
既定は1であり、同じキーのジョブは1件ずつ順に実行されます

```ts
await enqueue(env, {
  binding: 'CHARGE',
  payload: { customerId: 'c1', amountJpy: 1200 },
  concurrencyKey: 'customer:c1',
});
```

この保証が成立するのはshard数が1の場合です
2以上に設定した場合、shardを同じキーで決定しない限り、エラーにならないまま保証が無効になります。[shard](/guide/execution#shard)を参照してください

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
