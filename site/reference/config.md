---
title: 設定
description: defineTsumugiに指定する設定項目の型と既定値, wranglerのbindingの設定について
publishedAt: 2026-07-22
updatedAt: 2026-10-30
---

# 設定

## defineTsumugi

```ts
const tsumugi = defineTsumugi({
  performers,
  flows,
  schedules,
  runs,
  bindings,
  auth,
  ui,
  retention,
  metrics,
  onFailure,
  onSettled,
  onEnqueue,
});
```

`defineTsumugi`に型引数の指定は不要です。
bindingごとのpayloadの型と`Env`は、`performers`の内容から自動的に推論されます。

| 名前 | 必須 | 内容 |
| --- | --- | --- |
| `performers` | ○ | performerのモジュール。payloadと必須キーの型の導出元 |
| `flows` |  | Flow名と定義の対応。指定する場合は`RUN`のbindingが必要 |
| `schedules` |  | 定期実行の定義。指定する場合は`SCHEDULER`のbindingが必要 |
| `runs` |  | Runの上限と保持期間 |
| `bindings` |  | bindingごとのshard数, 実行量の制限, 保持期間 |
| `auth` |  | 認証。未設定時は、REST APIとダッシュボードへのすべてのリクエストが404 |
| `ui` |  | `tsumugi/ui`の`ui()`。未指定時は、ダッシュボードのバンドルなし |
| `retention` |  | 一覧の保持期間 |
| `metrics` |  | メトリクスの読み取り設定。未設定時は、`GET /api/metrics`が501 |
| `onFailure` |  | 失敗したジョブを通知するbinding名。未設定時は、通知なし |
| `onSettled` |  | 終了したジョブを通知するbinding名と、通知する状態 |
| `onEnqueue` |  | 投入ごとに実行オプションの既定値を設定する関数 |

### 戻り値

| 名前 | 内容 |
| --- | --- |
| `fetch`, `queue`, `scheduled` | default exportに含める`ExportedHandler`のハンドラ |
| `jobs(env)` | 型付きの投入オブジェクト(`JobQueue<M>`) |
| `enqueue(env, input)` | 1件のジョブの型付き投入。戻り値はジョブID |
| `enqueueMany(env, inputs)` | `enqueue`と同じ形式での複数ジョブの投入 |
| `shardFor(env, binding, partitionKey?)` | 投入先のshardのstub |
| `start(env, flow, input, options?)` | Runの開始。戻り値はrunId |
| `runFor(env, runId)` | Runのstub |
| `runClass` | wranglerに登録するRunのクラス |
| `schedulerClass` | wranglerに登録する定期実行のクラス |

`flows`を指定しない場合でも、戻り値には`start`, `runFor`, `runClass`が含まれます。
`flows`に定義されていないFlow名を`start`に渡すと、例外が発生します。
`RUN`のbindingが存在しない状態で`runFor`を呼び出した場合も、同様に例外が発生します。
投入方法ごとの違いは、[ジョブの投入](/guide/enqueue#投入方法)を参照してください。

## auth

| 関数 | 内容 |
| --- | --- |
| `bearerAuth` | 1つのトークンによる認証 |
| `cloudflareAccess` | Cloudflare AccessのJWTの検証 |
| `unsafeNoAuth` | 認証なし |

独自の認証関数を`auth`に指定することができます。
関数の引数は`request`と`env`で、戻り値は`Response`または`undefined`です。
詳細は[ダッシュボードと認証](/guide/dashboard#独自の認証)を参照してください。
`auth`を設定しない場合、REST APIとダッシュボードへのすべてのリクエストに404で応答します。
`unsafeNoAuth`の影響は、[ダッシュボードと認証](/guide/dashboard#認証しない構成)を参照してください。

## metrics

```ts
const tsumugi = defineTsumugi({
  performers,
  auth: bearerAuth((env: Env) => env.TSUMUGI_TOKEN),
  metrics: (env: Env) =>
    env.CF_ACCOUNT_ID && env.CF_API_TOKEN
      ? { accountId: env.CF_ACCOUNT_ID, apiToken: env.CF_API_TOKEN, dataset: 'tsumugi_jobs' }
      : undefined,
});
```

`metrics`は、記録したメトリクスをダッシュボードとREST APIで参照するための設定です。
`apiToken`は、Account Analyticsの読み取り権限を持つAPIトークンで、Secretとして設定してください。
`dataset`は、wranglerの設定ファイルの`analytics_engine_datasets`に記述したデータセット名です。
`metrics`を指定しない場合、`GET /api/metrics`は501で応答し、ダッシュボードのサイドバーにメトリクスの項目は表示されません。

## onFailure

```ts
const tsumugi = defineTsumugi({
  performers,
  onFailure: 'NotifyFailure',
});
```

`onFailure`は、失敗したジョブを通知するperformerのbinding名です。
通知先のperformerは、`FailureNotice`を受け取るものに限られます。
通知の条件と`FailureNotice`の内容は、[失敗の通知](/guide/execution#失敗の通知)を参照してください。

## onSettled

```ts
const tsumugi = defineTsumugi({
  performers,
  onSettled: { binding: 'NotifySettled', states: ['COMPLETED', 'FAILED'] },
});
```

`onSettled`は、終了したジョブを通知するperformerのbinding名と、通知する状態です。
`binding`は、`SettledNotice`を受け取るperformerに限られます。
`states`は必須で、`COMPLETED`, `FAILED`, `CANCELLED`, `STALLED`から選びます。
空の配列や不正な状態を指定すると、`defineTsumugi`で例外が発生します。
通知の条件と`SettledNotice`の内容は、[終了の通知](/guide/execution#終了の通知)を参照してください。

## onEnqueue

```ts
const tsumugi = defineTsumugi({
  performers,
  onEnqueue: (input) => (input.binding === 'SlowJob' ? { timeoutMs: 300_000 } : undefined),
});
```

`onEnqueue`は、ジョブの投入ごとに実行オプションの既定値を設定する関数です。
利用者が明示した値は、常に優先されます。
対象となる投入方法と、既定値が適用されるオプションの詳細は、[投入時の既定値](/guide/execution#投入時の既定値)を参照してください。

## RunSettings

| 名前 | 既定 | 内容 |
| --- | --- | --- |
| `maxNodes` | `10000` | 1つのRunに含められるノード数の上限。超過時はRunが失敗 |
| `maxDepth` | `3` | subflowの入れ子の上限。超過時はRunが失敗 |
| `sweepAfterMs` | 5分 | 終了したRunの保持時間 |
| `failedRetentionMs` | 7日 | `FAILED`のRunの保持時間。この期間内のRunは再開の対象 |

## BindingConfig

| 名前 | 既定 | 内容 |
| --- | --- | --- |
| `shards` | `1` | shard数。2以上では`partitionKey`が必須 |
| `policy` | 下記 | 実行量の制限とエージング |
| `sweepAfterMs` | 5分 | `COMPLETED`と`CANCELLED`のジョブの保持時間 |
| `failedRetentionMs` | 7日 | `FAILED`と`STALLED`のジョブの保持時間。この期間内のジョブはリトライの対象 |

## Policy

| 名前 | 既定 | 内容 |
| --- | --- | --- |
| `paused` | `false` | 投入の一時停止 |
| `concurrency` | `100` | 同時実行数の上限 |
| `perKeyConcurrency` | `1` | `concurrencyKey`ごとの同時実行数の上限 |
| `rate` | `null` | `{ tokens, intervalMs }`。`intervalMs`あたり`tokens`件までの実行 |
| `perKeyRate` | `null` | `{ tokens, intervalMs }`。キーごとの`intervalMs`あたり`tokens`件までの実行 |
| `agingIntervalMs` | `60000` | 実効優先度が1上がるまでの待ち時間。`null`はエージングなし |
| `reaperGraceMs` | `30000` | `timeoutMs`の経過後、結果が報告されないジョブを無応答と判定するまでの猶予 |

## EnqueueInput

| 名前 | 既定 | 内容 |
| --- | --- | --- |
| `binding` |  | 投入先のbinding名 |
| `payload` |  | performerへ渡す値 |
| `priority` | `0` | 数値の優先度。大きいほど先に実行 |
| `maxAttempts` | `3` | 試行回数の上限 |
| `backoff` | 指数 | `fixed`または`exponential` |
| `timeoutMs` | `60000` | タイムアウトまでの時間 |
| `delayMs` |  | 実行開始までの遅延 |
| `runAt` |  | 実行開始の時刻。`delayMs`と同時に指定不可 |
| `expiresInMs` |  | 投入時刻から数えた期限 |
| `expiresAt` |  | 期限の時刻。`expiresInMs`より優先 |
| `guarantee` | `at-least-once` | `at-least-once`または`at-most-once` |
| `concurrencyKey` |  | 同じキーのジョブを順に実行するためのキー |
| `uniqueKey` |  | 重複排除のキー |
| `uniqueForMs` | 24時間 | `uniqueKey`で重複を判定する期間 |
| `partitionKey` |  | shardを分割している場合に投入先を決めるキー |

オプションの詳細は、[ジョブの投入](/guide/enqueue#オプション)を参照してください。

`createClient`の`enqueue`は、`EnqueueInput`を引数に取ります。
`defineTsumugi`の`enqueue`が受け取る入力では、`binding`ごとにpayloadと必須キーの型が導出されます。

### backoffの既定値

```ts
{ kind: 'exponential', baseMs: 1_000, factor: 2, maxMs: 3_600_000, jitter: true }
```

## SweepOptions

| 名前 | 既定 | 内容 |
| --- | --- | --- |
| `olderThanMs` | 7日 | 終了したジョブとRunを一覧に残す時間 |
| `limit` | `1000` | 1回で削除する件数の上限。ジョブとRunそれぞれの件数 |

cronトリガーを設定すると、`olderThanMs`の経過後に終了したジョブとRunが一覧から削除されます。

Runの再開可能な期間は、`runs`で設定します。
`FAILED`のRunは、`olderThanMs`と`runs.failedRetentionMs`のうち、長い方の期間が経過した後、一覧から削除されます。
`FAILED`と`STALLED`のジョブも、`olderThanMs`とbindingの`failedRetentionMs`のうち、長い方の期間が経過した後、一覧から削除されます。

## wranglerのbinding

| binding | 種類 | 必須 | 用途 |
| --- | --- | --- | --- |
| `JOB_SHARD` | Durable Object | ○ | ジョブの管理 |
| `RUN` | Durable Object |  | Runの管理。`flows`を使う場合に必要 |
| `SCHEDULER` | Durable Object |  | 定期実行。`schedules`を使う場合に必要 |
| `TSUMUGI_DB` | D1 | ○ | 一覧と検索 |
| `TSUMUGI_QUEUE` | Queues | ○ | performerの実行 |
| `TSUMUGI_METRICS` | Analytics Engine |  | メトリクスの記録 |

`TSUMUGI_METRICS`が存在しない場合、メトリクスは記録されません。
その他の動作は変わりません。
他の必要なbindingが不足していると、REST APIは503で応答し、不足しているbindingの一覧が本文に含まれます。

`remote()`を指定したperformerには、Service Bindingが必要です。
binding名には、固定の名前を使用せず、`performers`のキーをそのまま指定します。

```jsonc
"services": [
  { "binding": "MAIL", "service": "my-mailer", "entrypoint": "SendMail" },
]
```

performerを持たず、ジョブの投入に限って使用するWorkerに必要なbindingは、`JOB_SHARD`に限られます。

## サブパス

| import元 | 内容 |
| --- | --- |
| `tsumugi` | `defineTsumugi`, `enqueue`, `bearerAuth`, `TsumugiJobShard`など |
| `tsumugi/performer` | `Performer` |
| `tsumugi/client` | `createClient`と関連する型 |
| `tsumugi/ui` | `ui()` |
| `tsumugi/types` | 型のみ |
| `tsumugi/testing` | `runPerformer`, `createTestContext`, `simulateFlow`など |

公開しているnpmパッケージは`tsumugi`です。
セットアップ用のCLIは`npx tsumugi`で実行します。
コマンドの一覧は[CLI](/reference/cli)を参照してください。
