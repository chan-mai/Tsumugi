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

投入済み未開始と実行中を1つにまとめると、performerが動作していないのか遅いだけなのかを区別できません
固着の診断ができなくなるので、`QUEUED`を分けています

逆に初回待ちとリトライ待ちは分けていません。`attempts`を見れば区別できるためです

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

取り消せるのは`SCHEDULED`のときだけです
`QUEUED`以降は既に実行されている可能性があるため、取り消し成功を返さない仕様にしています

## リトライ

試行回数もバックオフもDurable Objectが管理します
Queuesのretry機構は使わず、consumerは結果を報告したあと必ず即ackします

Queuesのretryに乗せると`maxAttempts`がwrangler.jsoncの`max_retries`に縛られ、製品仕様がインフラ設定に依存してしまうためです

### バックオフ

既定は指数バックオフです

```ts
{ kind: 'exponential', baseMs: 1_000, factor: 2, maxMs: 3_600_000, jitter: true }
```

固定間隔も指定できます

```ts
await enqueue(env, {
  binding: 'MAIL',
  payload,
  backoff: { kind: 'fixed', delayMs: 30_000, jitter: true },
});
```

`jitter`を有効にすると、同時に失敗した大量のジョブが同じタイミングで再試行するのを避けられます

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

キー単位の同時実行制御は、状態を1箇所で管理する設計でなければ実装できません
Durable Objectを置いていることによる利点がここに現れます

## エージング

優先度キューは、高優先のジョブが流入し続ける限り低優先が永久に実行されません
ダッシュボードでは`SCHEDULED`のままとしか見えないので、原因の特定も遅れます

そこで待ち時間に応じて実効優先度を上げます

```
effectivePriority = priority + floor(waited / agingIntervalMs)
```

既定は有効で、間隔は60秒です
厳密な優先順序が必要な場合は`agingIntervalMs`を`null`にすると無効化できます

## 実行保証

分散システムである以上、at-least-onceとat-most-onceは両立できません
どちらになるかは、完了報告が失われたときにreaperが再投入するかどうかで決まります

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

### claim

Cloudflare Queues自体がat-least-onceなので、reaperの再投入を止めただけではat-most-onceになりません

そこでat-most-onceのジョブだけ、実行前にDurable Objectへclaimを取得しに行きます
同じジョブの2回目は拒否されるので、重複配送されても二重には実行されません

往復が増えるコストを払うのは保証を指定したジョブだけです。既定のat-least-onceでは増えません

## タイムアウトと回収

`timeoutMs`を過ぎるとconsumerは待機を打ち切り、`signal`をabortします
performerの実行そのものは停止できません。ランタイムの制約で回避できません

さらに`reaperGraceMs`(既定30秒)だけ応答が無い状態が続いたジョブは、Durable Objectのreaperが回収します
試行回数が残っていれば保証に従って再投入か`STALLED`、使い切っていれば`FAILED`になります

## shard {#shard}

shard数の既定は1です

キー単位の制御は、shardもそのキーで決めないとエラーにならないまま無効になります
1から2に増やした時点で流量制御が壊れるため、分割は明示的なオプトインにしています

```ts
bindings: {
  MAIL: { shards: 4 },
}
```

2以上にすると`partitionKey`の指定が必須になります
`concurrencyKey`や`uniqueKey`の保証はpartition内に限定されます

- shardが1: binding内でキーは常に大域的に有効
- shardが2以上: `partitionKey`で決まったshardの中でのみ有効

既定を安全側に倒し、性能のために保証を弱める場合は明示的な指定を求める設計です
大半のbindingはshardという概念を意識せずに済みます

## 保持期間

終端したジョブがDurable Objectに残る時間は、用途が異なるので2つに分けてあります

| 対象                      | 設定                | 既定 |
| ------------------------- | ------------------- | ---- |
| `COMPLETED` / `CANCELLED` | `sweepAfterMs`      | 5分  |
| `FAILED` / `STALLED`      | `failedRetentionMs` | 7日  |

完了したジョブの明細はD1へ投影済みなので、Durable Objectに残す必要がありません
一方で`FAILED`と`STALLED`は手動リトライの対象なので、リトライを受け付ける期間がそのまま保持期間になります

D1側の保持は`retention`で指定し、cronトリガーの`scheduled`でcleanupします

```ts
const tsumugi = defineTsumugi<Env>({
  performers,
  retention: {/* SweepOptions */},
});
```

D1の一覧に表示されているジョブはリトライできる、という状態を保つため、両者の期間は揃えてあります
