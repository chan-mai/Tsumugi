---
title: REST API
description: ジョブ, Run, 定期実行, 実行量の設定を操作するREST APIのエンドポイントと、リクエストとレスポンスの形式について
publishedAt: 2026-07-22
updatedAt: 2026-10-25
---

# REST API

`auth`を設定すると、Tsumugiは`/api`以下のエンドポイントへのリクエストを処理します。
設定していない場合、すべてのリクエストに404で応答します。
認証は`/api/*`に限って適用されます。
ダッシュボードのHTMLはジョブのデータを含まないので、認証を要求せずに配信されます。
ダッシュボードは、認証されていない場合にトークンの入力欄を表示します。
OpenAPIの定義は、[`GET /api/openapi.json`](#get-apiopenapijson)で取得します。

## 共通のレスポンス

| 状態 | 意味 |
| --- | --- |
| 401 | 認証の失敗 |
| 501 | その操作が構成されていない状態 |
| 503 | 構成が未完了の状態, または一時的な利用不可 |

503の本文には、理由が含まれます。
未適用のマイグレーションが存在する場合は、未適用のファイル名が本文に含まれます。
bindingが不足している場合は、不足しているbindingの一覧が本文に含まれます。
一時的に利用できない場合は、時間を置いて再試行してください。

Flowを登録していない構成では、Runの開始, 再開, 取り消しのエンドポイントは501で応答します。
`/api/openapi.json`は、構成が完了していなくても応答します。
runIdの形式が不正な場合、`/api/runs/:id`を含むエンドポイントは400で応答します。

## ジョブ

### GET /api/jobs

ジョブの一覧を取得します。
レスポンスは、ジョブの配列と総件数を含みます。

#### クエリパラメータ

| 名前 | 既定 | 内容 |
| --- | --- | --- |
| `state` | なし | 状態によるフィルタ |
| `binding` | なし | binding名によるフィルタ |
| `id` | なし | ジョブIDの完全一致 |
| `unique_key` | なし | `uniqueKey`の完全一致 |
| `concurrency_key` | なし | `concurrencyKey`の完全一致 |
| `created_from` | なし | `created_at`の下限。epochミリ秒で、その値を含む |
| `created_to` | なし | `created_at`の上限。epochミリ秒で、その値を含む |
| `limit` | `20` | 最大100 |
| `offset` | `0` | 取得の開始位置 |
| `sort` | `updated_at` | `updated_at`, `created_at`, `binding`, `state`, `priority`, `attempts`のいずれか |
| `order` | `desc` | `asc`を指定した場合に限り昇順 |

複数の条件を指定した場合は、すべての条件を満たすジョブが一覧に含まれます。
キーの検索は完全一致で、部分一致は使用できません。
`sort`と`order`に不正な値を指定した場合は、400ではなく既定の並び順で応答します。
`created_from`と`created_to`に整数以外を指定した場合は、その条件は無視されます。

```json
{
  "jobs": [
    {
      "id": "MAIL#0:xxxxxxxxxxxxxxxxxxxxxxxx",
      "binding": "MAIL",
      "state": "FAILED",
      "priority": 0,
      "attempts": 3,
      "max_attempts": 3,
      "created_at": 1753000000000,
      "updated_at": 1753000060000,
      "dispatched_at": 1753000030000,
      "retryable": true
    }
  ],
  "total": 1
}
```

`retryable`は、保持期間に基づいて算出された目安です。
リトライの可否は、リトライ要求時に判定されます。
保持期間を過ぎたジョブのリトライには、410で応答します。

### GET /api/jobs/:id

ジョブ1件の詳細を取得します。
ジョブが見つからない場合は、404で応答します。

```json
{
  "job": {
    "id": "MAIL#0:xxxxxxxxxxxxxxxxxxxxxxxx",
    "binding": "MAIL",
    "state": "FAILED",
    "payload": "{\"to\":\"a@example.com\"}",
    "result": null,
    "priority": 0,
    "attempts": 3,
    "max_attempts": 3,
    "progress": null,
    "concurrency_key": "domain:example.com",
    "unique_key": null,
    "guarantee": "at-least-once",
    "created_at": 1753000000000,
    "updated_at": 1753000060000,
    "dispatched_at": 1753000030000,
    "run_after": null,
    "expires_at": null,
    "cancel_requested_at": null,
    "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    "retryable": true,
    "logs": [
      {
        "attempt": 1,
        "timestamp": 1753000011000,
        "message": "Payment requested"
      }
    ],
    "attempts_log": [
      {
        "attempt": 1,
        "state": "FAILED",
        "started_at": 1753000010000,
        "finished_at": 1753000012000,
        "error": "payment failed: 502"
      }
    ]
  }
}
```

| 項目 | 内容 |
| --- | --- |
| `result` | `perform`の戻り値。成功以外は`null` |
| `run_after` | 予約したジョブの実行予定時刻 |
| `expires_at` | 実行開始の期限。期限を過ぎたジョブは、実行されずに`CANCELLED`に遷移 |
| `cancel_requested_at` | [実行中の取り消し](/guide/execution#実行中の取り消し)を要求した時刻。要求なしの場合は`null` |
| `attempts_log` | 試行履歴。新しい試行から順 |
| `logs` | `ctx.log()`で保存したログ。受信順で、各項目は試行回数, 記録時刻(epochミリ秒), 本文。ログなしの場合は空配列。件数と本文の長さの上限は[ログ](/guide/performer#ログ)を参照 |
| `traceparent` | 投入時に指定したトレース情報。未指定の場合は`null` |

### POST /api/jobs

ジョブを投入します。
リクエストの本文は、次の形式のJSONです。

```json
{
  "binding": "MAIL",
  "payload": { "to": "a@example.com", "subject": "hi" },
  "maxAttempts": 5,
  "delayMs": 60000,
  "expiresInMs": 600000,
  "priority": 10,
  "concurrencyKey": "domain:example.com",
  "uniqueKey": "mail:a@example.com:hi",
  "partitionKey": "tenant-42",
  "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
}
```

`binding`と`payload`は必須で、`performers`に登録されたbindingを指定します。
`maxAttempts`, `delayMs`, `expiresInMs`, `priority`は整数にしてください。
上の例にない項目(`timeoutMs`, `backoff`など)は無視され、既定値が使われます。

`expiresInMs`は、ジョブの投入時刻から数えた実行期限です。
期限を過ぎたジョブは実行されず、`CANCELLED`へ遷移します。
`partitionKey`は、`shards`を2以上に設定したbindingにおいて、投入先のシャードを決定するためのキーであり、そのbindingでは必須です。

`traceparent`は任意です。
本文で指定しない場合は`traceparent`ヘッダの値が使われ、両方を指定した場合は本文の値が優先されます。
値には、[ジョブの投入](/guide/enqueue#トレース情報)で説明している、W3C Trace Contextのversion `00`の書式を使用してください。
指定した値は、リトライ時にも引き継がれ、performerの`ctx.traceparent`に渡されます。

`uniqueKey`が既存のジョブと同じ場合も201で応答し、新しいジョブは作成されず、本文には既存のジョブIDが含まれます。

| 状態 | 意味 |
| --- | --- |
| 201 | 作成。本文は`{ "id": "..." }` |
| 400 | JSONの不正, または検証の失敗(未登録のbinding, 整数以外の値, 不正な`traceparent`) |

### POST /api/jobs/:id/retry

`FAILED`または`STALLED`のジョブを`SCHEDULED`状態に遷移させます。
保持期間を過ぎて削除されたジョブは、リトライできません。

| 状態 | 意味 |
| --- | --- |
| 200 | リトライ済み |
| 400 | ジョブIDの形式の不正 |
| 409 | ジョブの状態が`FAILED`と`STALLED`のどちらでもない状態 |
| 410 | 存在しないジョブ, または保持期間を過ぎて削除されたジョブ |

409の場合は、ジョブの状態が変化してから、再び要求してください。

### POST /api/jobs/:id/cancel

ジョブを取り消します。
対象は、`SCHEDULED`, `QUEUED`, `RUNNING`のジョブです。

`SCHEDULED`のジョブは、直ちに`CANCELLED`に遷移します。
`QUEUED`と`RUNNING`のジョブは、既に実行されている可能性があるので、取り消しの要求として記録されます。
この場合、レスポンスに`requested: true`が含まれます。
ジョブは、performerが要求を確認して終了した場合か、要求から`reaperGraceMs`(既定30秒)が過ぎても結果が報告されない場合に、`CANCELLED`に遷移します。
詳細は、[実行中の取り消し](/guide/execution#実行中の取り消し)を参照してください。

```json
{ "ok": true, "requested": true }
```

取り消しを要求済みのジョブに再び要求した場合も、`requested: true`で応答します。
終了したジョブへの要求には、409で応答します。
そのほかのレスポンスは、`retry`と同一です。

### POST /api/jobs/bulk-retry

### POST /api/jobs/bulk-cancel

複数のジョブをまとめてリトライまたは取り消します。
対象は、ジョブIDの配列、またはフィルタ条件のいずれかで指定します。

ジョブIDで指定する場合は`ids`を指定し、フィルタ条件で指定する場合は`ids`を省略します。

```json
{ "ids": ["MAIL#0:xxxxxxxxxxxxxxxxxxxxxxxx", "MAIL#0:yyyyyyyyyyyyyyyyyyyyyyyy"] }
```

```json
{ "binding": "MAIL", "state": "FAILED", "created_from": 1753000000000, "limit": 200 }
```

| 項目 | 必須 | 説明 |
| --- | --- | --- |
| `ids` | 任意 | ジョブIDの配列。1件以上200件以下 |
| `binding` | 任意 | binding名によるフィルタ |
| `state` | 任意 | `bulk-retry`は`FAILED`, `STALLED`。`bulk-cancel`は`SCHEDULED`, `QUEUED`, `RUNNING` |
| `unique_key` | 任意 | 完全一致 |
| `concurrency_key` | 任意 | 完全一致 |
| `created_from` | 任意 | `created_at`の下限 |
| `created_to` | 任意 | `created_at`の上限 |
| `limit` | 任意 | 1回で処理する件数。1以上, 既定と最大はいずれも200 |

`ids`を指定した場合、他の条件は無視されます。
`created_from`, `created_to`, `limit`には整数を指定してください。

条件で`state`を省略した場合、`bulk-retry`の対象は`FAILED`と`STALLED`のジョブ、`bulk-cancel`の対象は`SCHEDULED`, `QUEUED`, `RUNNING`のジョブです。
これ以外の状態を指定した場合は、400で応答します。
`bulk-retry`では、`failedRetentionMs`を過ぎたジョブは対象から除外されます。
`bulk-cancel`では、すでに取り消しを要求済みのジョブは、`CANCELLED`が確定するまで対象から除外されます。
`ids`でジョブを直接指定した場合は、すでに要求済みのジョブに対して再度要求しても、二重に処理されることはありません。

```json
{
  "ok": ["MAIL#0:xxxxxxxxxxxxxxxxxxxxxxxx"],
  "failed": [{ "id": "MAIL#0:yyyyyyyyyyyyyyyyyyyyyyyy", "reason": "gone" }],
  "remaining": 320
}
```

一部のジョブの処理に失敗した場合も、ステータスコードは200です。
`bulk-cancel`では、取り消しの要求として記録されたジョブも`ok`に含まれます。
`failed`の`reason`は、1件ずつのリトライと取り消しのエンドポイントが応答するエラーに対応します。
`invalid-state`と`gone`は、それぞれ409と410に相当します。
`ids`にジョブIDとして不正な値が含まれている場合は、その値が`invalid-id`として`failed`に含まれます。

`remaining`は、条件で指定したときに`limit`を超えて処理されなかった件数です。
0になるまで、同じ要求を再送してください。
`ids`で指定した場合は、`remaining`は常に0です。
要求の時点で条件に合わないジョブは、一覧に表示されていても`failed`に含まれます。

### POST /api/jobs/:id/reschedule

予約したジョブの実行時刻を変更します。対象は、`SCHEDULED`のジョブです。

```json
{ "runAt": 1753003600000, "priority": 10 }
```

| 項目 | 必須 | 説明 |
| --- | --- | --- |
| `runAt` | 条件 | 絶対時刻。`delayMs`と同時に指定不可 |
| `delayMs` | 条件 | 現在時刻からの相対。`runAt`と同時に指定不可 |
| `priority` | 任意 | 同時に変更する場合に指定 |

`runAt`と`delayMs`は、いずれか一方を指定してください。
両方を指定した場合と、どちらも指定しない場合は、400で応答します。
`runAt`, `delayMs`, `priority`は整数にしてください。

ジョブIDは変わりません。
`uniqueKey`による重複の判定も継続します。
ステータスコードは、`retry`と同一です。

## 集計と診断

### GET /api/stats

状態別の件数を取得します。

```json
{
  "byState": { "SCHEDULED": 12, "RUNNING": 3, "COMPLETED": 480, "FAILED": 2 },
  "oldestScheduledMs": 45000
}
```

`oldestScheduledMs`は、最も古い`SCHEDULED`のジョブが投入されてからの経過時間をミリ秒で表します。
`SCHEDULED`のジョブが存在しない場合、値は`null`です。

### GET /api/metrics

記録したメトリクスをもとに、bindingごとの失敗率と所要時間を取得します。

#### クエリパラメータ

| 名前 | 既定 | 内容 |
| --- | --- | --- |
| `hours` | `24` | 集計する時間。1以上720以下の整数 |
| `binding` | なし | binding名によるフィルタ |

```json
{
  "hours": 24,
  "bindings": [
    {
      "binding": "MAIL",
      "total": 1200,
      "failed": 18,
      "failureRate": 0.015,
      "avgDurationMs": 820,
      "maxDurationMs": 5400,
      "p95DurationMs": 2100,
      "avgAttempts": 1.04
    }
  ],
  "series": [{ "at": 1753000000000, "total": 50, "failed": 1, "avgDurationMs": 810 }]
}
```

メトリクスがサンプリングされている期間も、実際の件数に近い値が含まれます。
`hours`が範囲外の場合と、`binding`が不正な名前の場合は、400で応答します。
`metrics`を設定していない構成では、501で応答します。
502は、メトリクスを取得できなかった場合の応答で、本文に理由が含まれます。

### GET /api/diagnostics

bindingごとに、実行待ちのジョブが実行されない原因を取得します。実行中のジョブの件数と、現在の実行量の設定も含まれます。

```json
{
  "bindings": {
    "MAIL": {
      "active": 2,
      "blocked": { "paused": false, "capacity": true, "tokens": false, "perKey": false, "perKeyTokens": false },
      "policy": {
        "paused": false,
        "concurrency": 100,
        "perKeyConcurrency": 1,
        "rate": null,
        "perKeyRate": null,
        "agingIntervalMs": 60000,
        "reaperGraceMs": 30000
      }
    }
  }
}
```

| 項目 | 意味 |
| --- | --- |
| `active` | 実行中のジョブの件数 |
| `blocked` | 実行待ちのジョブの実行を制限している設定 |
| `policy` | 現在適用している実行量の設定 |

#### blocked

| 項目 | 制限 |
| --- | --- |
| `paused` | 一時停止 |
| `capacity` | 同時実行数 |
| `tokens` | レート |
| `perKey` | キーごとの同時実行数 |
| `perKeyTokens` | キーごとのレート |

### GET /api/bindings

ジョブを投入するbinding名の一覧を取得します。
一度も実行されていないbindingを含め、`performers`に登録したすべてのbinding名が取得対象です。

```json
{ "bindings": ["CHARGE", "MAIL"] }
```

## 実行量の設定

### POST /api/bindings/:binding/policy

実行量の設定を、実行時に変更します。
変更は、`bindings`の設定より優先されます。

```json
{ "paused": true, "concurrency": 5 }
```

| 項目 | 説明 |
| --- | --- |
| `paused` | 投入の一時停止。停止中も実行中のジョブの監視は継続 |
| `concurrency` | 同時実行数。0以上の整数 |
| `perKeyConcurrency` | キーごとの同時実行数。0以上の整数 |
| `rate` | `{ tokens, intervalMs }`。`null`でレートの制限を解除 |
| `perKeyRate` | `{ tokens, intervalMs }`。キーごとのレート。`null`で制限を解除 |
| `agingIntervalMs` | エージングの間隔。`null`でエージングなし |
| `reaperGraceMs` | 無応答と判定するまでの猶予。0以上の整数 |

指定した項目のみが変更され、省略した項目は維持されます。
成功時には、変更後の設定と適用されたshardの数がレスポンスに含まれます。
以下は、`paused`と`concurrency`を変更した場合の例です。

```json
{
  "binding": "MAIL",
  "shards": 1,
  "policy": {
    "paused": true,
    "concurrency": 5,
    "perKeyConcurrency": 1,
    "rate": null,
    "perKeyRate": null,
    "agingIntervalMs": 60000,
    "reaperGraceMs": 30000
  }
}
```

変更は、対象のbindingに属するすべてのshardに適用されます。
shardを分割している場合、ネットワークの分断や一時的な障害により、一部のshardへの変更の適用に失敗する可能性があります。
その場合は、HTTPステータスコード500で応答し、本文に失敗したshardの番号が含まれます。

```json
{ "error": "the change reached 3 of 4 shards, send the same request again", "binding": "MAIL", "shards": 4, "failed": [2] }
```

同じ要求を再び送信すると、残りのshardに変更が適用されます。
何度送信しても、設定の結果は同一です。
変更後は、`bindings`の設定が適用されなくなります。

### POST /api/bindings/:binding/policy/reset

実行時の変更を破棄し、`bindings`の設定に戻します。
次の投入から、`bindings`の設定が再び適用されます。

```json
{ "ok": true }
```

一部のshardへの適用に失敗した場合は、`policy`の変更と同様に、500で応答し、`failed`が本文に含まれます。

## 定期実行

`schedules`を定義していない構成では、このセクションのエンドポイントは501で応答します。
詳細は、[定期実行](/guide/schedule)を参照してください。

### GET /api/schedules

定期実行の一覧を取得します。
ジョブの一覧とは異なり、状態はリアルタイムで反映されます。

```json
{
  "schedules": [
    {
      "name": "nightly",
      "kind": "flow",
      "target": "REPORT",
      "every_ms": null,
      "cron": "0 3 * * *",
      "time_zone": "Asia/Tokyo",
      "overlap": "skip",
      "paused": false,
      "next_occurrence_at": 1767722400000,
      "last_occurrence_at": 1767636000000,
      "last_fired_at": 1767636001200,
      "last_job_id": null,
      "last_run_id": "REPORT:nightly-1767636000000",
      "last_skipped_at": null,
      "skipped_count": 0,
      "last_error": null
    }
  ]
}
```

| 項目 | 意味 |
| --- | --- |
| `name` | スケジュールの名前。`schedules`のキー |
| `kind` | `job`または`flow` |
| `target` | binding名またはFlow名 |
| `every_ms` | 固定間隔。`cron`を指定した場合は`null` |
| `cron` | cron式。`everyMs`を指定した場合は`null` |
| `time_zone` | cronと表示に使うIANAタイムゾーン。固定間隔では`UTC` |
| `overlap` | `skip`または`overlap` |
| `paused` | 一時停止中かどうか |
| `next_occurrence_at` | 次回の実行予定 |
| `last_occurrence_at` | 前回の実行の予定時刻。一度も実行していない場合は`null` |
| `last_fired_at` | 前回の実行の実際の時刻。`last_occurrence_at`との差が実行の遅れ |
| `last_job_id` | 前回の実行で投入したジョブのID。`kind`が`flow`の場合は`null` |
| `last_run_id` | 前回の実行で開始したRunのID。`kind`が`job`の場合は`null` |
| `last_skipped_at` | 最後に実行しなかった回の時刻。該当する回がない場合は`null` |
| `skipped_count` | 前回の実行が終了していなかったために実行しなかった回数 |
| `last_error` | 前回の実行が失敗した理由。成功した場合は`null` |

末尾が`_at`の項目は、epochミリ秒です。

### POST /api/schedules/:name/pause

一時停止中は、定期的な実行が行われません。
停止前に投入されたジョブは、影響を受けません。

```json
{ "ok": true }
```

### POST /api/schedules/:name/resume

一時停止中のスケジュールを再開します。
停止中に経過した回は、実行されません。
再開後の次の実行は、再開した時点より後の最初の予定時刻です。

```json
{ "ok": true }
```

### POST /api/schedules/:name/trigger

スケジュールを直ちに1回実行します。

```json
{ "id": "REPORT:nightly-1767650000000-1-manual", "kind": "flow" }
```

`id`は、投入したジョブのIDまたは開始したRunのIDです。
`kind`は、`id`がジョブとRunのどちらを示すかを表します。
一時停止中でも実行され、`overlap`の判定は行われません。
次の定期実行の時刻は、変更されません。
実行に失敗した場合は、500とエラーの詳細で応答します。
一覧の`last_error`の値は、このエラーの詳細と同一です。

## Run

### GET /api/flows

登録済みのFlow名を取得します。
実行の有無にかかわらず、`flows`に登録したすべてのFlow名が対象です。

```json
{ "flows": ["GREETINGS", "PIPELINE"] }
```

### GET /api/runs

Runの一覧を取得します。
各Runについて、ノードの進捗状況が含まれます。

#### クエリパラメータ

| 名前 | 既定 | 説明 |
| --- | --- | --- |
| `state` | なし | `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED`のいずれか |
| `flow` | なし | Flow名によるフィルタ |
| `limit` | 20 | 最大100 |
| `offset` | 0 | ページング |

```json
{
  "runs": [
    {
      "id": "GREETINGS:cl9x0a1b2c3d",
      "flow": "GREETINGS",
      "state": "RUNNING",
      "node_total": 6,
      "node_done": 4,
      "node_failed": 0,
      "created_at": 1767225600000,
      "updated_at": 1767225603000
    }
  ],
  "total": 1
}
```

### GET /api/runs/:id

Run1件と、そのRunに含まれるノードを取得します。
ノードには、事前に定義された静的なノードと、実行時に動的に追加されたノードの両方が含まれます。

```json
{
  "run": {
    "id": "GREETINGS:cl9x0a1b2c3d",
    "flow": "GREETINGS",
    "state": "RUNNING",
    "input": "{\"prefix\":\"hello\"}",
    "node_total": 6,
    "node_done": 4,
    "node_failed": 0,
    "created_at": 1767225600000,
    "updated_at": 1767225603000,
    "parent_run_id": null,
    "parent_node_id": null,
    "retryable": false
  },
  "nodes": [
    {
      "id": "greet",
      "binding": "GREET",
      "state": "RUNNING",
      "container": true,
      "parent": null,
      "origin": "static",
      "after": ["list"],
      "job_id": null,
      "child_run_id": null,
      "result": null,
      "error": null,
      "position": 1,
      "created_at": 1767225600000,
      "updated_at": 1767225603000
    }
  ]
}
```

`container`が`true`のノードは、fan-outのノードです。
fan-outのノードはジョブを持たないため、`job_id`は`null`です。
`result`は、子ノードの集計値を含みます。
`parent`を持つノードは、実行時に追加されたノードです。
`origin`は`fanOut`または`spawn`です。
subflowとして開始されたRunでは、`parent_run_id`と`parent_node_id`に、親のRunとノードのIDが含まれます。
subflowのノードでは、`child_run_id`に、開始した子のRunのrunIdが含まれます。

### POST /api/runs

Runを開始します。
リクエストの本文は、Flow名と入力を含むJSONです。

```json
{ "flow": "GREETINGS", "input": { "prefix": "hello" }, "id": "order-1234" }
```

| 項目 | 必須 | 説明 |
| --- | --- | --- |
| `flow` | 必須 | 登録済みのFlow名。未登録の場合は400 |
| `input` | 必須 | 任意のJSON。型検査の適用なし |
| `id` | 任意 | runIdのローカル部。同じIDでの2回目の開始は、既存のrunIdで応答 |
| `deadlineMs` | 任意 | Run全体の期限(ミリ秒)。正の整数。期限超過時は中断と`FAILED`への遷移。Flowの定義の期限より優先 |

成功すると、201で応答し、本文は開始したRunのrunIdを含みます。
次の例のrunIdは、`flow`と`id`から作られた`GREETINGS:order-1234`です。

```json
{ "id": "GREETINGS:order-1234" }
```

### POST /api/runs/:id/retry

失敗したRunを再開します。
完了したノードの結果は、そのまま引き継ぎます。
`FAILED`, `STALLED`, `SKIPPED`, `CANCELLED`のノードは、未実行として再度実行します。
fan-outで作成された子ノードのうち、再実行されるのは、Runの期限を過ぎて中断された子ノードに限られます。
実行して失敗した子ノードは、再実行しません。

再開の対象は、`FAILED`のRunに限られます。
それ以外の状態のRunには、409で応答します。
存在しないRunと保持期間を過ぎたRunには、410で応答します。

### POST /api/runs/:id/cancel

Runを取り消します。
未実行のノードは開始されず、実行中のノードには[取り消しの要求](/guide/execution#実行中の取り消し)が送信されます。
実行中のジョブは停止されません。
performerが要求を確認して終了した場合か、要求から`reaperGraceMs`(既定30秒)が過ぎても結果が報告されない場合に、Runは`CANCELLED`に遷移します。
取り消しの対象は、`RUNNING`のRunに限られます。

## GET /api/openapi.json

すべてのエンドポイントのパラメータと応答の形式を記述したOpenAPI 3.1の定義を取得します。
