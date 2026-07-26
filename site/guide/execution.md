# 実行の制御

## 状態

ジョブは7つの状態を持ちます

| 状態        | 意味                                            |
| ----------- | ----------------------------------------------- |
| `SCHEDULED` | 実行待ち。初回待ちもリトライ待ちも含む          |
| `QUEUED`    | Queuesに投入済み、performerはまだ開始していない |
| `RUNNING`   | performerが実行中                               |
| `COMPLETED` | 成功                                            |
| `FAILED`    | 試行回数を使い切って失敗                        |
| `CANCELLED` | 取り消された                                    |
| `STALLED`   | 応答が無く回収できず、手動での判断を待っている  |

`QUEUED`と`RUNNING`は別の状態です。performerが未開始か実行中かの判別が可能です

初回待ちとリトライ待ちはどちらも`SCHEDULED`です。判別には`attempts`を使います

### 遷移

```
SCHEDULED → QUEUED, CANCELLED
QUEUED    → RUNNING, COMPLETED, FAILED, SCHEDULED, STALLED
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
await enqueue(env, {
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
const tsumugi = defineTsumugi<Env>({
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
await enqueue(env, {
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
試行回数が残っていれば保証に従って再投入か`STALLED`、使い切っていれば`FAILED`になります

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

一覧そのものの保持は`retention`で指定し、cronトリガーの`scheduled`で削除します

```ts
const tsumugi = defineTsumugi<Env>({
  performers,
  retention: {/* SweepOptions */},
});
```

既定では両者の期間が揃っているため、一覧に表示されているジョブはリトライが可能です
片方だけ変えると、一覧に表示されていてもリトライを受け付けないジョブが出ます
