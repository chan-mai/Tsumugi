# 設定

## defineTsumugi

```ts
const tsumugi = defineTsumugi<Env>({
  performers,
  flows,
  runs,
  bindings,
  auth,
  ui,
  retention,
  metrics,
});
```

| 名前         | 必須 | 内容                                                          |
| ------------ | ---- | ------------------------------------------------------------- |
| `performers` | ○    | binding名とperformerの対応。`remote()`との混在も可能          |
| `flows`      |      | Flow名と定義の対応。指定すると`RUN`のbindingが必要            |
| `runs`       |      | Runの上限と保持期間の設定                                     |
| `bindings`   |      | binding単位の分割数、流量制御、保持期間                       |
| `auth`       |      | 認証ミドルウェア。未設定の場合はAPIもダッシュボードも無効     |
| `ui`         |      | `tsumugi/ui`の`ui()`。未指定の場合はバンドルに含まれない      |
| `retention`  |      | 一覧の保持設定                                                |
| `metrics`    |      | Analytics Engineの読み取り設定。未設定の場合はメトリクスが無効 |

戻り値は`fetch`と`queue`と`scheduled`を持つハンドラで、`enqueue`と`enqueueMany`と`shardFor`も提供します
`flows`を指定した場合は`start`と`runFor`、wranglerに登録するクラスの`runClass`も提供します

## metrics

Analytics Engineに書いた値をダッシュボードから参照する場合に指定します

```ts
const tsumugi = defineTsumugi<Env>({
  performers,
  auth: bearerAuth((env: Env) => env.TSUMUGI_TOKEN),
  metrics: (env: Env) =>
    env.CF_ACCOUNT_ID && env.CF_API_TOKEN
      ? { accountId: env.CF_ACCOUNT_ID, apiToken: env.CF_API_TOKEN, dataset: 'tsumugi_jobs' }
      : undefined,
});
```

`apiToken`にはAccount Analyticsの読み取り権限が必要です。secretとして設定してください
`dataset`はwranglerの`analytics_engine_datasets`に書いた名前と揃えます

指定しない場合、メトリクスのタブとAPIは無効です

## RunSettings

`runs`に指定する値です

| 名前                | 既定    | 内容                                                        |
| ------------------- | ------- | ----------------------------------------------------------- |
| `maxNodes`          | `10000` | 1つのRunに含められるノード数の上限。超過するとRunが失敗する |
| `sweepAfterMs`      | 5分     | 終了したRunを保持する時間                                   |
| `failedRetentionMs` | 7日     | 失敗したRunを保持する時間。再開の対象となる期間             |

## BindingConfig

`bindings`の各値です

| 名前                | 既定 | 内容                                               |
| ------------------- | ---- | -------------------------------------------------- |
| `shards`            | `1`  | 分割数。2以上にすると`partitionKey`が必須になる    |
| `policy`            | 下記 | 流量制御とエージング                               |
| `sweepAfterMs`      | 5分  | `COMPLETED`と`CANCELLED`をDurable Objectに残す時間 |
| `failedRetentionMs` | 7日  | `FAILED`と`STALLED`をDurable Objectに残す時間      |

## Policy

| 名前                | 既定    | 内容                                                         |
| ------------------- | ------- | ------------------------------------------------------------ |
| `concurrency`       | `100`   | 同時実行数の上限                                             |
| `perKeyConcurrency` | `1`     | `concurrencyKey`単位の上限。キーがnullのジョブには適用しない |
| `rate`              | `null`  | `{ tokens, intervalMs }`のトークンバケット                   |
| `agingIntervalMs`   | `60000` | この間隔だけ待つごとに実効優先度が1上がる。`null`で無効      |
| `reaperGraceMs`     | `30000` | `timeoutMs`の経過後さらにこの時間応答が無ければ回収する      |

## EnqueueInput

| 名前             | 既定            | 内容                                |
| ---------------- | --------------- | ----------------------------------- |
| `binding`        |                 | 投入先のbinding名                   |
| `payload`        |                 | performerへ渡す値                   |
| `priority`       | `0`             | 数値優先度。大きいほど先に投入する  |
| `maxAttempts`    | `3`             | 試行回数の上限                      |
| `backoff`        | 指数            | `fixed`か`exponential`              |
| `timeoutMs`      | `60000`         | 結果を待つ時間の上限                |
| `delayMs`        |                 | 実行開始の遅延                      |
| `runAt`          |                 | 絶対時刻での予約。`delayMs`とは排他 |
| `guarantee`      | `at-least-once` | `at-least-once`か`at-most-once`     |
| `concurrencyKey` |                 | キー単位の直列化                    |
| `uniqueKey`      |                 | 重複排除                            |
| `uniqueForMs`    | 24時間          | `uniqueKey`の予約を保持する期間     |
| `partitionKey`   |                 | 分割時の投入先の決定に使う          |

### backoffの既定値

```ts
{ kind: 'exponential', baseMs: 1_000, factor: 2, maxMs: 3_600_000, jitter: true }
```

## wranglerのbinding

名前は固定です

| binding           | 種類             | 用途                            |
| ----------------- | ---------------- | ------------------------------- |
| `JOB_SHARD`       | Durable Object   | スケジューラ兼調停役            |
| `RUN`             | Durable Object   | Runの実行。`flows`を使う場合    |
| `TSUMUGI_DB`      | D1               | 読み取りモデル                  |
| `TSUMUGI_QUEUE`   | Queues           | performerへの配送               |
| `TSUMUGI_METRICS` | Analytics Engine | 時系列メトリクス                |

投入のみを行うWorkerに必要なbindingは`JOB_SHARD`だけです

## サブパス

| import元            | 内容                                                             |
| ------------------- | ---------------------------------------------------------------- |
| `tsumugi`           | `defineTsumugi` `enqueue` `bearerAuth` `TsumugiJobShard`など本体 |
| `tsumugi/performer` | `Performer` `RemotePerformer`                                    |
| `tsumugi/client`    | `createClient`。Durable Object実装を含まない                     |
| `tsumugi/ui`        | `ui()`。ダッシュボードのHTML                                     |
| `tsumugi/types`     | 型のみ。ランタイムコードを含まない                               |
| `tsumugi/testing`   | `schedule` `nextAttempt`など純粋関数                             |

公開しているnpmパッケージは`tsumugi`のみです
performerだけを持つWorkerがDurable Objectの実装をバンドルしないよう、サブパスで分割しています
