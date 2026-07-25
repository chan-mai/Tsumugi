# REST API

`auth`を設定すると`/api`以下が有効になります。設定していない場合はすべて404です

認証は`/api/*`にのみ掛かります
HTML自体はデータを含まないので未認証でも返します。これによりSPA側でトークン入力欄を表示できます

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
        "error": "決済に失敗: 502"
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
登録簿にないbindingは受け付けません。投入できても実行時に必ず失敗するためです

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
| 409  | 今の状態では実行できない                         |
| 410  | 保持期間を過ぎてDurable Objectから削除されている |

409と410を分けているのは、利用者側の対処が異なるためです
409は状態が変わるのを待てばよく、410はそのジョブでは回復できません

## POST /api/jobs/:id/cancel

ジョブを取り消します。`SCHEDULED`の場合のみ実行できます

`QUEUED`以降は既に実行されている可能性があるため409を返します
取り消せていないジョブに成功を返さないための制約です

返る状態は`retry`と同じです

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

登録簿に含まれるbindingを返します
一度も実行されていないbindingも選択できるようにするためであり、投影済みのbindingのみを返すわけではありません

## GET /api/runs

runの一覧を返します。Run DOはrunごとに独立しているため、横断的な一覧は読み取りモデルを参照します

### クエリパラメータ

| 名前     | 既定 | 説明                                       |
| -------- | ---- | ------------------------------------------ |
| `state`  | なし | `RUNNING` `COMPLETED` `FAILED` `CANCELLED` |
| `flow`   | なし | flow名による絞り込み                       |
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

1つのrunと、そのノードを並び順で返します

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

`container`はfan-outノードを示します。自身はジョブを実行しないため`job_id`を持たず、`result`には子ノードの集計値が入ります
`parent`を持つノードは実行時に追加されたノードであり、`origin`は`fanOut`または`spawn`になります

## POST /api/runs

runを開始します

```json
{ "flow": "GREETINGS", "input": { "prefix": "hello" }, "id": "order-1234" }
```

| 項目    | 必須 | 説明                                                    |
| ------- | ---- | ------------------------------------------------------- |
| `flow`  | 必須 | 登録済みのflow名。未登録は400                           |
| `input` | 必須 | 任意のJSON。型検査は適用されないため、不正な入力は実行時に失敗します |
| `id`    | 任意 | runIdのローカル部。同じIDの2回目は既存のrunIdを返します |

成功すると201でrunIdが返ります

```json
{ "id": "GREETINGS:order-1234" }
```

## POST /api/runs/:id/retry

失敗したrunを再開します。失敗したノードは新しいジョブとして再作成され、`SKIPPED`にした下流は未実行の状態に戻ります
`RUNNING`と`COMPLETED`のrunには409、保持期間を過ぎてDurable Objectから削除されたrunには410を返します

## POST /api/runs/:id/cancel

未実行のノードを停止します。Queuesへ投入済みのジョブは取り消せないため、終端状態に達するまで待ちます
`RUNNING`以外のrunには409を返します
