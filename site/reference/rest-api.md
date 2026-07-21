# REST API

`auth`を設定すると`/api`以下が有効になります。設定していない場合はすべて404です

認証は`/api/*`にのみ掛かります
HTML自体はデータを含まないので未認証でも返します。これによりSPA側でトークン入力欄を表示できます

## GET /api/jobs

一覧を引きます

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

`retryable`は保持期間からの引き算による近似値です
実際の可否を判定するのはDurable Objectなので、期間を過ぎたジョブへのリトライは410を返します

## GET /api/jobs/:id

1件の詳細を引きます。試行履歴が付くのはこちらだけです

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
登録簿にないbindingは入口で弾きます。投入はできても実行時に必ず失敗するためです

成功すると201で`{ "id": "..." }`が返ります

| 状態 | 意味                                 |
| ---- | ------------------------------------ |
| 201  | 作成した                             |
| 400  | JSONが壊れている、または検証に落ちた |
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

ジョブを取り消します。`SCHEDULED`のときだけ通ります

`QUEUED`以降は既に実行されている可能性があるため409になります
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

登録簿にあるものを返します
一度も動いていないbindingも選べるようにするためで、投影済みのものだけを返しているわけではありません
