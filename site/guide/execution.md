# 実行の制御

## 状態

ジョブは7つの状態を持ちます

| 状態        | 意味                                            |
| ----------- | ----------------------------------------------- |
| `SCHEDULED` | 実行待ち。初回待ちもリトライ待ちも含む          |
| `QUEUED`    | Queuesに投入済み。実行中の場合も含む            |
| `RUNNING`   | performerが実行中。`at-most-once`のみ           |
| `COMPLETED` | 成功                                            |
| `FAILED`    | 試行回数を使い切って失敗                        |
| `CANCELLED` | 取り消された                                    |
| `STALLED`   | 応答が無く回収できず、手動での判断を待っている  |

`RUNNING`へ遷移するのは`at-most-once`のジョブのみです
既定の`at-least-once`では`QUEUED`のまま実行されるため、`QUEUED`は未開始と実行中の両方を含みます

初回待ちとリトライ待ちはどちらも`SCHEDULED`です。判別には`attempts`を使います

### 遷移

```
SCHEDULED → QUEUED, CANCELLED
QUEUED    → RUNNING(at-most-onceのみ), COMPLETED, FAILED, SCHEDULED, STALLED
RUNNING   → COMPLETED, FAILED, SCHEDULED, STALLED
COMPLETED → なし
CANCELLED → なし
FAILED    → SCHEDULED
STALLED   → SCHEDULED
```

`FAILED`と`STALLED`から`SCHEDULED`へ戻る遷移は、ダッシュボードやREST APIからの手動リトライです

取り消しが可能なのは`SCHEDULED`の場合のみです
`QUEUED`以降は既に実行されている可能性があるため、取り消しの要求を受け付けません

## リトライ

試行回数とバックオフは`maxAttempts`と`backoff`で決まります

wrangler.jsoncの`max_retries`は別の層の設定で、Queuesがメッセージを再配送する回数です
consumerは結果を報告したあと常にackするため通常は作用しませんが、配送そのものが失敗した場合の再配送回数を決めます

### バックオフ

既定は指数バックオフです

```ts
{ kind: 'exponential', baseMs: 1_000, factor: 2, maxMs: 3_600_000, jitter: true }
```

固定間隔の指定も可能です

```ts
await tsumugi.enqueue(env, {
  binding: 'MAIL',
  payload,
  backoff: { kind: 'fixed', delayMs: 30_000, jitter: true },
});
```

`jitter`を有効にすると、同時に失敗した多数のジョブの再試行が同じ時刻に集中しません

## 流量制御

binding単位に3軸で宣言します

| 軸                  | 既定   | 内容                                   |
| ------------------- | ------ | -------------------------------------- |
| `concurrency`       | `100`  | 同時実行数の上限                       |
| `rate`              | `null` | トークンバケットによるレート制限       |
| `perKeyConcurrency` | `1`    | `concurrencyKey`単位の同時実行数の上限 |

```ts
const tsumugi = defineTsumugi({
  performers,
  bindings: {
    MAIL: {
      policy: {
        concurrency: 20,
        rate: { tokens: 100, intervalMs: 60_000 },
        perKeyConcurrency: 1,
      },
    },
  },
});
```

`concurrencyKey`がnullのジョブに`perKeyConcurrency`は適用されません

3軸を全て有効にした場合のスループット低下は実測で約17%です

### 滞留の診断 {#diagnostics}

投入したジョブが実行されない場合、[GET /api/diagnostics](/reference/rest-api#get-api-diagnostics)で、どの軸によって止まっているかを確認できます

### 実行時の上書き

`tsumugi.shardFor`で取得したstubの`configure`で、デプロイなしに`policy`と保持期間を変更できます

```ts
await tsumugi.shardFor(env, 'MAIL').configure({ policy: { concurrency: 5 } });
```

一度`configure`を実行すると、以降は`bindings`の静的な設定より`configure`の内容が優先されます
静的な設定へ戻す場合は、改めて`configure`で同じ内容を指定します

## エージング

高優先度のジョブが継続して投入される限り、低優先度のジョブは実行されません
これを避けるため、待ち時間に応じて実効優先度を上げます

```text
effectivePriority = priority + floor(waited / agingIntervalMs)
```

既定は有効で、間隔は60秒です
厳密な優先順序が必要な場合は`agingIntervalMs`に`null`を指定します

## 実行保証

ジョブごとに選択します。違いは、完了の報告が届かなかったときの挙動です

| 保証                  | 応答が無いときの挙動                            |
| --------------------- | ----------------------------------------------- |
| `at-least-once`(既定) | `SCHEDULED`へ戻して再投入する                   |
| `at-most-once`        | 再投入せず`STALLED`に落とし、手動での判断を待つ |

```ts
await tsumugi.enqueue(env, {
  binding: 'CHARGE',
  payload,
  guarantee: 'at-most-once',
});
```

`at-most-once`を指定したジョブは、同じジョブが二度実行されることがありません
その代わり1回あたりの往復が1つ増えます。既定の`at-least-once`では増えません

## タイムアウトと回収

`timeoutMs`を過ぎると待機を打ち切ります
performerには期限が`ctx.deadlineAt`として渡るため、中断に応じるかはperformer側の実装に依存します
どちらの場合もperformerの実行そのものは停止しません

さらに`reaperGraceMs`(既定30秒)だけ応答が無い状態が続いたジョブは回収されます
`at-most-once`のジョブは、試行回数に関わらず`STALLED`になります
`at-least-once`のジョブは、試行回数が残っていれば再投入され、使い切っていれば`FAILED`になります

## shard {#shard}

shard数の既定は1です

```ts
bindings: {
  MAIL: { shards: 4 },
}
```

2以上にすると`partitionKey`の指定が必須になります
`concurrencyKey`や`uniqueKey`の保証はpartition内に限定されます

- shardが1: binding内でキーは常に有効
- shardが2以上: `partitionKey`で決まったshardの中でのみ有効

`concurrencyKey`や`uniqueKey`を使う場合は、`partitionKey`にも同じキーを指定してください
指定しないとエラーにならないまま保証が無効になります

## 保持期間

リトライを受け付ける期間は`failedRetentionMs`で決まります

| 対象                      | 設定                | 既定 |
| ------------------------- | ------------------- | ---- |
| `COMPLETED` / `CANCELLED` | `sweepAfterMs`      | 5分  |
| `FAILED` / `STALLED`      | `failedRetentionMs` | 7日  |

どちらも`bindings`のbinding単位で指定します

```ts
const tsumugi = defineTsumugi({
  performers,
  bindings: {
    MAIL: { sweepAfterMs: 60 * 60 * 1000, failedRetentionMs: 14 * 24 * 60 * 60 * 1000 },
  },
});
```

一覧そのものの保持はこれとは別の設定で、`retention`で指定します
cronトリガーを設定すると、期間を過ぎた終了済みのジョブが一覧から削除されます。[SweepOptions](/reference/config#sweepoptions)を参照してください

既定では両者の期間が揃っているため、一覧に表示されているジョブはリトライが可能です
片方だけ変えると、一覧に表示されていてもリトライを受け付けないジョブが出ます
