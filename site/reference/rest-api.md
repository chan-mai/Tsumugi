# REST API

`auth`を設定すると`/api`以下が有効になります。設定していない場合はすべて404です

認証は`/api/*`にのみ掛かります
HTML自体はデータを含まないため未認証でも返します。SPA側はこれを受けてトークン入力欄を表示します

機械可読な仕様は[`/api/openapi.json`](#get-api-openapi-json)が返します。

## GET /api/jobs

一覧を取得します

### クエリパラメータ

| 名前      | 既定         | 内容                                                              |
| --------- | ------------ | ----------------------------------------------------------------- |
| `state`   | なし         | 状態での絞り込み                                                  |
| `binding` | なし         | binding名での絞り込み                                             |
| `limit`   | `20`         | 最大100                                                           |
| `offset`  | `0`          |                                                                   |
| `sort`    | `updated_at` | `updated_at` `created_at` `binding` `state` `priority` `attempts` |
| `order`   | `desc`       | `asc`を指定したときだけ昇順                                       |

`sort`と`order`に不正な値が来ても400にはせず、既定値を使います。UIが停止しないようにするためです

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
    "attempts": 3,
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

成功すると201で`{ "id": "..." }`が返ります

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
| `limit`           | 任意 | 1回で処理する件数。既定と最大はいずれも200 |

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

`remaining`は条件で指定した場合に、上限で処理しきれなかった件数です。0になるまで同じ要求を繰り返します
読み取りモデルは数秒遅れるため、この値は見積りです。`ids`で指定した場合は常に0です

対象は読み取りモデルから引きますが、状態の判定はDurable Object側で改めて行います
一覧に表示されていても、その時点で条件に合わないジョブは`failed`に入ります

## GET /api/stats

状態別の件数を返します

```json
{ "byState": { "SCHEDULED": 12, "RUNNING": 3, "COMPLETED": 480, "FAILED": 2 } }
```

## GET /api/bindings

投入先の選択肢と絞り込み用のbinding名を返します

```json
{ "bindings": ["CHARGE", "MAIL"] }
```

一度も実行されていないbindingも含めて、`performers`に登録された全てのbindingを返します

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
  "run": { "id": "GREETINGS:cl9x0a1b2c3d", "flow": "GREETINGS", "state": "RUNNING", "retryable": false },
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
      "result": null,
      "error": null,
      "position": 1
    }
  ]
}
```

`container`はfan-outノードを示します。ジョブを持たないので`job_id`はnullで、`result`には子ノードの集計値が入ります
`parent`を持つノードは実行時に追加されたノードで、`origin`は`fanOut`または`spawn`になります

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

失敗したRunを再開します。失敗したノードは新しいジョブとして再作成され、`SKIPPED`にした下流は未実行の状態に戻ります
`RUNNING`と`COMPLETED`のRunには409、保持期間を過ぎたRunには410を返します

## POST /api/runs/:id/cancel

未実行のノードを停止します。実行中のジョブは停止しないので、それらが終わるまで待ちます
`RUNNING`以外のRunには409を返します

## GET /api/openapi.json

OpenAPI 3.1の定義を返します。全エンドポイントのパラメータと応答の形を記述したものです
