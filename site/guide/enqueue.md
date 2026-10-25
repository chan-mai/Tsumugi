---
title: ジョブの投入
description: enqueue, enqueueMany, jobsによるジョブの投入方法と、予約実行, 有効期限, 重複排除, 直列化などの投入時のオプションについて
publishedAt: 2026-07-22
updatedAt: 2026-10-25
---

# ジョブの投入

## 投入方法

| 方法 | 型 | shard数と実行量の設定の取得元 |
| --- | --- | --- |
| `tsumugi.enqueue` / `tsumugi.jobs(env)` | bindingごとに導出されるpayloadと必須キーの型 | `defineTsumugi`の`bindings` |
| `createClient(bindings)` | `binding`は`string`, `payload`は`unknown` | `createClient`の第1引数 |

performerと同じWorkerからは、`defineTsumugi`の戻り値を使ってジョブを投入します。
`createClient`は、performerを持たないWorkerからジョブを投入するためのクライアントです。

必要なbindingが不足していると、`tsumugi.enqueue`, `tsumugi.enqueueMany`, `tsumugi.jobs(env)`は例外を発生させます。
例外には、不足しているbindingの一覧が含まれます。
`JOB_SHARD`, `TSUMUGI_DB`, `TSUMUGI_QUEUE`は、常に必須です。
`flows`を使う場合は`RUN`を、`schedules`を使う場合は`SCHEDULER`を追加します。
`remote()`のperformerには、対応するService Bindingを用意します。

## enqueue

```ts
const id = await tsumugi.enqueue(env, {
  binding: 'MAIL',
  payload: { to: 'a@example.com', subject: 'hi' },
});
```

戻り値はジョブIDです。
payloadの型は、指定した`binding`の値から導出されます。
必須キーを指定しない場合、コンパイルエラーが発生します。

## enqueueMany

`tsumugi.enqueueMany`は、複数のジョブを一括で投入します。

```ts
const ids = await tsumugi.enqueueMany(env, [
  { binding: 'MAIL', payload: { to: 'a@example.com', subject: 'hi' } },
  { binding: 'MAIL', payload: { to: 'b@example.com', subject: 'hi' } },
]);
```

件数が増えても、所要時間はほとんど変わりません。
戻り値の配列では、i番目の要素が入力のi番目のジョブに対応するIDです。

## jobs

`tsumugi.jobs(env)`の戻り値は、`env`を事前に指定した型付きジョブ投入用オブジェクトです。

```ts
const jobs = tsumugi.jobs(env);

const id = await jobs.enqueue('MAIL', { to: 'a@example.com', subject: 'hi' });
await jobs.enqueue('CHARGE', { customerId: 'c1', amountJpy: 1200 }, { concurrencyKey: 'customer:c1' });
```

投入される内容は、`tsumugi.enqueue`と同一です。
違いは引数の形式に限られます。
[キーを必須にしたperformer](/guide/performer#キーの必須化)では、`options`を省略した場合と、キーを指定しなかった場合に、コンパイルエラーが発生します。

## オプション

| 名前 | 既定 | 内容 |
| --- | --- | --- |
| `priority` | `0` | 数値の優先度。大きいほど先に実行 |
| `maxAttempts` | `3` | 試行回数の上限。1以上の整数 |
| `backoff` | 指数, 1秒から開始, 係数2, 上限1時間, ジッタあり | リトライの間隔 |
| `timeoutMs` | `60000` | タイムアウトまでの時間 |
| `delayMs` | なし | 実行開始までの遅延。`runAt`と同時に指定不可 |
| `runAt` | なし | 実行開始の時刻。`delayMs`と同時に指定不可 |
| `expiresInMs` | なし | 投入時刻から数えた期限 |
| `expiresAt` | なし | 期限の時刻。`expiresInMs`より優先 |
| `guarantee` | `at-least-once` | 実行保証。重複実行を避ける場合は`at-most-once` |
| `concurrencyKey` | なし | 同じキーのジョブを順に実行するためのキー |
| `uniqueKey` | なし | 重複排除のキー |
| `uniqueForMs` | 24時間 | `uniqueKey`で重複を判定する期間 |
| `partitionKey` | なし | shardを分割している場合に投入先を決めるキー |
| `traceparent` | なし | 投入元のW3C Trace Context |

shard数が2以上のbindingでは、`partitionKey`を省略すると例外が発生します。
`partitionKey`で投入先のshardを選択するのは、`bindings`の`shards`を適用する投入方法に限られます。
詳細は[投入方法](#投入方法)を参照してください。

## 予約実行

```ts
// 1時間後
await tsumugi.enqueue(env, { binding: 'MAIL', payload, delayMs: 60 * 60 * 1000 });

// 指定時刻
await tsumugi.enqueue(env, { binding: 'MAIL', payload, runAt: Date.parse('2026-08-01T09:00:00+09:00') });
```

## 有効期限

`expiresInMs`または`expiresAt`を指定すると、期限を過ぎたジョブは実行されずに`CANCELLED`へ遷移します。
一時停止や実行の遅れの後でも、期限切れの通知がまとめて実行されることはありません。

```ts
// 5分以内に開始できなければ実行しない
await tsumugi.enqueue(env, { binding: 'NOTIFY', payload, expiresInMs: 5 * 60 * 1000 });
```

実行中のジョブは、期限を過ぎても中断されません。
次のリトライ予定時刻が期限より後の場合、ジョブは失敗時に`CANCELLED`へ遷移します。
`FAILED`および`STALLED`のジョブを手動でリトライする際も、期限が適用されます。

## 重複排除

`uniqueKey`を指定すると、同じキーのジョブがすでに存在するときは新しいジョブを作成しません。
このときの戻り値は、既存のジョブのIDです。

```ts
const id = await tsumugi.enqueue(env, {
  binding: 'SYNC',
  payload: { sku: 'X-1' },
  uniqueKey: 'sku:X-1',
});
```

重複した投入はエラーになりません。
例外も発生しません。
`uniqueForMs`の期間が経過すると、重複の判定は解除されます。
同じキーで再度投入すれば、新しいジョブが作成されます。

## 直列化

`concurrencyKey`が同じジョブは、`perKeyConcurrency`の件数まで同時に実行されます。
既定値は1なので、同じキーのジョブは1件ずつ順に実行されます。

```ts
await tsumugi.enqueue(env, {
  binding: 'CHARGE',
  payload: { customerId: 'c1', amountJpy: 1200 },
  concurrencyKey: 'customer:c1',
});
```

shard数が2以上のbindingでは、この直列化は`partitionKey`が同じshardの中に限られます。
詳細は[shard](/guide/execution#shard)を参照してください。

## トレース情報

投入時に`traceparent`を指定すると、performerの`ctx.traceparent`に同じ値が渡されます。
リトライ時も同じ値が渡され、ダッシュボードはジョブの詳細にこの値を表示します。
`enqueueMany`は、ジョブごとの`traceparent`を受け付けます。

```ts
await tsumugi.enqueue(env, {
  binding: 'MAIL',
  payload: { to: 'a@example.com', subject: 'hi' },
  traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
});
```

形式はW3C Trace Contextのversion `00`(55文字)です。
各項目は小文字の16進数で記述します。
形式が正しくない値を指定すると、投入時に検証エラーが発生します。
trace-idまたはparent-idのすべての桁が0の値を指定した場合も、検証エラーが発生します。

## ジョブID

```
<binding>#<shard>:<localId>
```

例: `MAIL#0:xxxxxxxxxxxxxxxxxxxxxxxx`

shard数を変更しても、既存のジョブIDは同一のジョブを識別します。
ただし、変更の前後で、`partitionKey`の値が同じジョブの投入先shardは変わる可能性があります。
`concurrencyKey`と`uniqueKey`による制御はshardごとに実行されるので、投入先のshardが異なるジョブの間には適用されません。
shard数を減らすと、範囲外になったshardには[実行時の設定変更](/guide/execution#実行時の変更)が適用されません。
shardの詳細は、[shard](/guide/execution#shard)を参照してください。

## 別Workerからの投入

performerを持たないWorkerからの投入については、[別Workerからの投入](/guide/client)を参照してください。
