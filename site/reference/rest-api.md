# REST API

`auth`を設定すると`/api`以下が有効になります。設定していない場合はすべて404です

認証は`/api/*`にのみ掛かります
HTML自体はデータを含まないため未認証でも返します。SPA側はこれを受けてトークン入力欄を表示します

機械可読な仕様は[`/api/openapi.json`](#get-api-openapi-json)が返します。

## 共通のレスポンス {#common-responses}

| 状態 | 意味                                             |
| ---- | ------------------------------------------------ |
| 401  | 認証に失敗した                                   |
| 501  | その操作が構成されていない                       |
| 503  | 構成が完了していない、または一時的に利用できない |

503の応答本文には理由が含まれます
未適用のマイグレーションがある場合は未適用のファイル名が、bindingが不足している場合は不足の一覧が含まれます
一時的な障害の場合は、時間を置いて再試行してください

Flowを登録していない構成では、Runの開始と再開と取り消しが501になります

`/api/openapi.json`は構成が完了していなくても取得可能です

## GET /api/jobs

一覧を取得します

### クエリパラメータ

| 名前              | 既定         | 内容                                                              |
| ----------------- | ------------ | ----------------------------------------------------------------- |
| `state`           | なし         | 状態での絞り込み                                                  |
| `binding`         | なし         | binding名での絞り込み                                             |
| `id`              | なし         | ジョブIDの完全一致                                                |
| `unique_key`      | なし         | `uniqueKey`の完全一致                                             |
| `concurrency_key` | なし         | `concurrencyKey`の完全一致                                        |
| `created_from`    | なし         | `created_at`の下限。epochミリ秒で、その値を含む                   |
| `created_to`      | なし         | `created_at`の上限。epochミリ秒で、その値を含む                   |
| `limit`           | `20`         | 最大100                                                           |
| `offset`          | `0`          |                                                                   |
| `sort`            | `updated_at` | `updated_at` `created_at` `binding` `state` `priority` `attempts` |
| `order`           | `desc`       | `asc`を指定したときだけ昇順                                       |

複数の条件を指定した場合は、全てを満たす行のみが返ります

キーの一致は完全一致のみです。部分一致は索引が利用されず、件数が増えると全表走査になるため受け付けません

`sort`と`order`に不正な値が来ても400にはせず、既定値を使います。UIが停止しないようにするためです
期間に数値以外が来た場合も同様に、その条件を無視します

### レスポンス

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

`retryable`は保持期間から算出した近似値です
実際の可否を判定するのはDurable Objectであり、保持期間を過ぎたジョブへのリトライは410を返します

## GET /api/jobs/:id

1件の詳細を取得します。試行履歴を含むのはこのエンドポイントのみです

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
    "retryable": true,
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

`result`はperformの戻り値で、成功時のみ値が含まれます。それ以外はnullです
`run_after`は予約済みジョブの実行予定時刻です
`attempts_log`は新しい試行から順に並びます

見つからない場合は404です

## POST /api/jobs

ジョブを投入します

```json
{
  "binding": "MAIL",
  "payload": { "to": "a@example.com", "subject": "hi" },
  "maxAttempts": 5,
  "delayMs": 60000,
  "priority": 10,
  "concurrencyKey": "domain:example.com",
  "uniqueKey": "mail:a@example.com:hi"
}
```

`binding`と`payload`が必須です
`performers`にないbindingは受け付けません。投入できても実行時に必ず失敗するためです

指定できるのは上記の項目のみです。`timeoutMs`や`backoff`などは指定できず、既定値が使われます
`partitionKey`も指定できないため、分割したbindingへの投入には利用できません

成功すると201で`{ "id": "..." }`が返ります
`uniqueKey`が既存のジョブと衝突した場合も201です。新規には作成されず、応答には既存のジョブIDが含まれます

| 状態 | 意味                                 |
| ---- | ------------------------------------ |
| 201  | 作成した                             |
| 400  | JSONが不正、または検証に失敗した      |
| 501  | 投入経路が構成されていない           |

## POST /api/jobs/:id/retry

`FAILED`か`STALLED`のジョブを`SCHEDULED`へ戻します

| 状態 | 意味                                             |
| ---- | ------------------------------------------------ |
| 200  | 受け付けた                                       |
| 400  | ジョブIDの形式が不正                             |
| 409  | 現在の状態では受け付けない                       |
| 410  | 保持期間を過ぎて削除されている                   |

409と410は対処が異なります。409は状態の変化を待って再実行し、410はそのジョブの再開が不可能です

## POST /api/jobs/:id/cancel

ジョブを取り消します。対象は`SCHEDULED`のジョブのみです

`QUEUED`以降は既に実行されている可能性があるため409を返します

返る状態は`retry`と同様です

## POST /api/jobs/bulk-retry

## POST /api/jobs/bulk-cancel

複数のジョブをまとめて処理します。対象はIDの列挙か、絞り込み条件のいずれかで指定します

IDで指定する場合は`ids`のみを渡します

```json
{ "ids": ["MAIL#0:xxxxxxxxxxxxxxxxxxxxxxxx", "MAIL#0:yyyyyyyyyyyyyyyyyyyyyyyy"] }
```

条件で指定する場合は`ids`を省略します

```json
{ "binding": "MAIL", "state": "FAILED", "created_from": 1753000000000, "limit": 200 }
```

| 項目              | 必須 | 説明                                       |
| ----------------- | ---- | ------------------------------------------ |
| `ids`             | 任意 | ジョブIDの配列。1件以上200件以下           |
| `binding`         | 任意 | binding名での絞り込み                      |
| `state`           | 任意 | 操作が受け付ける状態のみ指定できます       |
| `unique_key`      | 任意 | 完全一致                                   |
| `concurrency_key` | 任意 | 完全一致                                   |
| `created_from`    | 任意 | `created_at`の下限                         |
| `created_to`      | 任意 | `created_at`の上限                         |
| `limit`           | 任意 | 1回で処理する件数。1以上、既定と最大はいずれも200 |

`ids`を指定した場合、他の条件は無視されます

条件で指定し`state`を省略した場合、`bulk-retry`は`FAILED`と`STALLED`、`bulk-cancel`は`SCHEDULED`を対象とします
これ以外の状態を指定した場合は400を返します。対象が減らず、繰り返しても終わらないためです

### レスポンス

```json
{
  "ok": ["MAIL#0:xxxxxxxxxxxxxxxxxxxxxxxx"],
  "failed": [{ "id": "MAIL#0:yyyyyyyyyyyyyyyyyyyyyyyy", "reason": "gone" }],
  "remaining": 320
}
```

一部が断られても全体は200です。全体を失敗にすると、成功した分まで再送されるためです

`reason`は個別のリトライと取り消しが返す理由に対応します。`invalid-state`は409、`gone`は410に相当します
`ids`にジョブIDとして不正な値が含まれていた場合、その要素は`invalid-id`として`failed`に含まれます

`remaining`は条件で指定した場合に、上限で処理しきれなかった件数です。0になるまで同じ要求を繰り返します
読み取りモデルは数秒遅れるため、この値は見積りです。`ids`で指定した場合は常に0です

対象は読み取りモデルから引きますが、状態の判定はDurable Object側で改めて行います
一覧に表示されていても、その時点で条件に合わないジョブは`failed`に入ります

## POST /api/jobs/:id/reschedule

予約済みジョブの実行時刻を変更します。対象は`SCHEDULED`のジョブのみです

```json
{ "runAt": 1753003600000, "priority": 10 }
```

| 項目       | 必須 | 説明                                          |
| ---------- | ---- | --------------------------------------------- |
| `runAt`    | 条件 | 絶対時刻。`delayMs`とは排他                   |
| `delayMs`  | 条件 | 現在時刻からの相対。`runAt`とは排他           |
| `priority` | 任意 | 同時に変更する場合に指定                      |

`runAt`と`delayMs`はどちらか一方が必要です。両方を指定すると400を返します

ジョブIDは変わりません。取り消して再投入する場合と異なり、`uniqueKey`の予約も解放されません

返る状態は`retry`と同様です

## GET /api/stats

状態別の件数を返します

```json
{
  "byState": { "SCHEDULED": 12, "RUNNING": 3, "COMPLETED": 480, "FAILED": 2 },
  "oldestScheduledMs": 45000
}
```

`oldestScheduledMs`は最も古い`SCHEDULED`のジョブが投入から待たされている時間です。対象が無い場合はnullです

## GET /api/metrics

Analytics Engineに書いた時系列から、binding別の失敗率と所要時間を返します

### クエリパラメータ

| 名前      | 既定 | 内容                    |
| --------- | ---- | ----------------------- |
| `hours`   | `24` | 遡る時間。1以上720以下  |
| `binding` | なし | binding名での絞り込み   |

### レスポンス

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

件数と所要時間はサンプリングの重みを掛けて集計し、サンプリングが有効になった区間でも実際の件数に近い値が返ります

`hours`が範囲外、または`binding`が不正な名前の場合は400になります
`metrics`を設定していない構成では501を返します
Analytics Engine側が要求を断った場合と応答が無い場合は502を返し、本文に理由が入ります

## GET /api/diagnostics

bindingごとの滞留の診断情報を取得します

```json
{
  "shard": 0,
  "bindings": {
    "MAIL": {
      "active": 2,
      "outbox": 0,
      "blocked": { "capacity": 0, "tokens": 5, "perKey": 1 }
    }
  }
}
```

| 項目      | 意味                                             |
| --------- | ------------------------------------------------ |
| `active`  | 実行中の件数                                     |
| `outbox`  | 一覧への反映を待っている件数                     |
| `blocked` | 実行待ちのジョブがどの制約で止まっているかの内訳 |

`blocked`の内訳は、`capacity`が同時実行数、`tokens`がレート、`perKey`がキー単位の上限に対応します

対象はshard 0のみです。分割している場合、他のshardは含まれません

## GET /api/bindings

投入先の選択肢と絞り込み用のbinding名を返します

```json
{ "bindings": ["CHARGE", "MAIL"] }
```

一度も実行されていないbindingも含めて、`performers`に登録された全てのbindingを返します

## GET /api/flows

登録済みのFlow名を取得します

```json
{ "flows": ["GREETINGS", "PIPELINE"] }
```

一度も実行されていないFlowも含めて、`flows`に登録された全てのFlow名を取得できます

## GET /api/runs

Runの一覧を返します

### クエリパラメータ

| 名前     | 既定 | 説明                                       |
| -------- | ---- | ------------------------------------------ |
| `state`  | なし | `RUNNING` `COMPLETED` `FAILED` `CANCELLED` |
| `flow`   | なし | Flow名による絞り込み                       |
| `limit`  | 20   | 最大100                                    |
| `offset` | 0    | ページング                                 |

### レスポンス

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

## GET /api/runs/:id

1つのRunと、そのノードを並び順で返します

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

`container`はfan-outノードを示します。ジョブを持たないので`job_id`はnullで、`result`には子ノードの集計値が含まれます
`parent`を持つノードは実行時に追加されたノードで、`origin`は`fanOut`または`spawn`になります
subflowとして起動されたRunでは、`parent_run_id`と`parent_node_id`に親のRunとノードのIDが含まれます
subflowのノードでは、起動した子のrunIdが`child_run_id`に含まれます

## POST /api/runs

Runを開始します

```json
{ "flow": "GREETINGS", "input": { "prefix": "hello" }, "id": "order-1234" }
```

| 項目    | 必須 | 説明                                                    |
| ------- | ---- | ------------------------------------------------------- |
| `flow`  | 必須 | 登録済みのFlow名。未登録は400                           |
| `input` | 必須 | 任意のJSON。型検査は適用されません                       |
| `id`    | 任意 | runIdのローカル部。同じIDの2回目は既存のrunIdを返します |

成功すると201でrunIdが返ります

```json
{ "id": "GREETINGS:order-1234" }
```

## POST /api/runs/:id/retry

失敗したRunを再開します
完了したノードの結果はそのまま使われ、`FAILED` `STALLED` `SKIPPED` `CANCELLED`のノードは未実行の状態に戻り、改めて実行されます

再開できるのは`FAILED`のRunのみです。それ以外は409、保持期間を過ぎたRunは410になります
runIdの形式が不正な場合は400です

## POST /api/runs/:id/cancel

未実行のノードを停止します。実行中のジョブは停止しないので、それらが終わるまで待ちます

取り消しできるのは`RUNNING`のRunのみです。それ以外は409になります
runIdの形式が不正な場合は400です

## GET /api/openapi.json

OpenAPI 3.1の定義を返します。全エンドポイントのパラメータと応答の形を記述したものです
