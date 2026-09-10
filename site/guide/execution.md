# 実行の制御

## 状態

ジョブは以下7つの状態を持ちます。

| 状態        | 意味                                                   |
| ----------- | ------------------------------------------------------ |
| `SCHEDULED` | 実行待ち。初回待ちもリトライ待ちも含む                 |
| `QUEUED`    | Queuesに投入済み。実行中の場合も含む                   |
| `RUNNING`   | performerが実行中。`at-most-once`のみ                  |
| `COMPLETED` | 成功                                                   |
| `FAILED`    | 試行回数を使い切って失敗                               |
| `CANCELLED` | 取り消された                                           |
| `STALLED`   | 結果が報告されないまま停止し、手動での判断を待っている |

`RUNNING`へ遷移するのは`at-most-once`のジョブのみであり、`at-least-once`のジョブは`QUEUED`のまま実行されるため、`QUEUED`は未開始と実行中の両方を含みます。

初回待ちとリトライ待ちはどちらも`SCHEDULED`です。判別には`attempts`を参照してください。

### 遷移

```text
SCHEDULED → QUEUED, CANCELLED
QUEUED    → RUNNING(at-most-onceのみ), COMPLETED, FAILED, SCHEDULED, STALLED
RUNNING   → COMPLETED, FAILED, SCHEDULED, STALLED
COMPLETED → なし
CANCELLED → なし
FAILED    → SCHEDULED
STALLED   → SCHEDULED
```

`FAILED`と`STALLED`から`SCHEDULED`へ戻る遷移は、ダッシュボードやREST APIからの手動リトライに限ります。

取り消しが可能なのは`SCHEDULED`の場合のみであり、既に実行されている可能性を排除するため、原則として`QUEUED`以降は取り消しの要求を受け付けません。

## リトライ

試行回数とバックオフは`maxAttempts`と`backoff`により決定されます。`maxAttempts`は1以上の整数、`backoff`は固定間隔または指数バックオフを指定可能です。

::: info
wrangler.jsoncで定義される`max_retries`はQueues固有の設定であり、Tsumugiのリトライ機構への影響はありません。
:::

### バックオフ

既定は指数バックオフです。

```ts
{ kind: 'exponential', baseMs: 1_000, factor: 2, maxMs: 3_600_000, jitter: true }
```

固定間隔の指定も可能です。

```ts
await tsumugi.enqueue(env, {
  binding: 'MAIL',
  payload,
  backoff: { kind: 'fixed', delayMs: 30_000, jitter: true },
});
```

`jitter`を有効にすることで、同時に失敗した多数のジョブの再試行が同じ時間帯に集中することを避けられます。

## 流量制御

binding単位に以下4つの設定で宣言します。

| 設定                | 既定   | 内容                                             |
| ------------------- | ------ | ------------------------------------------------ |
| `concurrency`       | `100`  | 同時実行数の上限                                 |
| `rate`              | `null` | 一定時間あたりの実行数の上限                     |
| `perKeyConcurrency` | `1`    | `concurrencyKey`単位の同時実行数の上限           |
| `perKeyRate`        | `null` | `concurrencyKey`単位の一定時間あたりの実行数の上限 |

```ts
const tsumugi = defineTsumugi({
  performers,
  bindings: {
    MAIL: {
      policy: {
        concurrency: 20,
        rate: { tokens: 100, intervalMs: 60_000 },
        perKeyConcurrency: 1,
        perKeyRate: { tokens: 10, intervalMs: 60_000 },
      },
    },
  },
});
```

`perKeyRate`はすべてのキーに同じ値が適用され、キーごとに異なる値は指定できません。
`concurrencyKey`がnullのジョブに`perKeyConcurrency`と`perKeyRate`は適用されません。

`concurrency` / `rate` / `perKeyConcurrency`の3つを有効にした場合のスループット低下は実測で約17%です。

### 実行されない原因の確認 {#diagnostics}

投入したジョブが実行されない場合、[GET /api/diagnostics](/reference/rest-api#get-api-diagnostics)で、どの設定によって滞留しているかを確認できます。

### 実行時の上書き

ダッシュボードの`bindings`タブから、変更デプロイなしに同時実行数の変更と投入の一時停止が可能です。変更はすべてのshardへ適用されます。
この操作は[POST /api/bindings/:binding/policy](/reference/rest-api#post-api-bindings-binding-policy)と等価です。

![bindingsタブ](/dashboard-bindings.jpg)

```bash
curl -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"paused": true}' https://example.com/api/bindings/MAIL/policy
```

一時停止中も、実行中のジョブの監視とエージングは継続します。
再開後の投入順は通常と同じく実効優先度順であり、停止中も待ち時間は増え続けるため、低優先度のジョブほど順位が上がります。

コードから変更する場合は`tsumugi.shardFor`で取得したstubの`configure`を利用してください。保持期間もあわせて変更可能です。

```ts
await tsumugi.shardFor(env, 'MAIL').configure({ policy: { concurrency: 5 } });
```

前述の通り、ダッシュボード/REST APIを介した操作が優先されるため、実行時に変更操作を行うことにより、以降は`bindings`の静的な設定が適用されません。
静的な設定へ戻す場合は[POST /api/bindings/:binding/policy/reset](/reference/rest-api#post-api-bindings-binding-policy-reset)を使うか、改めて`configure`で同じ内容を指定する必要があります。

## エージング

高優先度のジョブが継続して投入される限り、低優先度のジョブは実行されません。
これを避けるため、待ち時間に応じて実効優先度が上がるオプションが既定で有効になっています。

```text
effectivePriority = priority + floor(waited / agingIntervalMs)
```

このオプションは既定で有効になっており、間隔は60秒です。
厳密な優先順序が必要な場合は`agingIntervalMs`に`null`を指定してください。

## 実行保証

実行保証はジョブごとに指定可能です。`at-least-once`と`at-most-once`の2種類があります。

| 保証                  | 結果が報告されないときの動作                  |
| --------------------- | --------------------------------------------- |
| `at-least-once`(既定) | `SCHEDULED`へ戻して再投入する                 |
| `at-most-once`        | 再投入せず`STALLED`にして、手動での判断を待つ |

```ts
await tsumugi.enqueue(env, {
  binding: 'CHARGE',
  payload,
  guarantee: 'at-most-once',
});
```

`at-most-once`を指定したジョブは、同じジョブが二度実行されず、実行を開始するまでの時間が既定の`at-least-once`より長くなります。

## タイムアウトと無応答の検知

`timeoutMs`を過ぎると結果の待機を終了します。
performerには期限が`ctx.deadlineAt`として渡るため、中断に応じるかはperformer側の実装に依存します。
どちらの場合においても、原則としてperformerの実行そのものは停止しません。

さらに`reaperGraceMs`(既定30秒)だけ結果が報告されない状態が続いたジョブは、無応答として扱われます。
`at-most-once`のジョブは、試行回数に関わらず`STALLED`になります。
`at-least-once`のジョブは、試行回数が残っていれば再投入され、そうでない場合は`FAILED`として扱われます。

## shard {#shard}

既定のshard数は1です。

```ts
bindings: {
  MAIL: { shards: 4 },
}
```

shard数を2以上にすると`partitionKey`の指定が必須になり、`concurrencyKey`や`uniqueKey`の保証がpartition内に限定されます。

- shardが1: binding内でキーは常に有効
- shardが2以上: `partitionKey`で決まったshardの中でのみ有効

`concurrencyKey`や`uniqueKey`を使う場合、`partitionKey`にも同じキーを指定する必要があります。
指定を行わない場合、実行保証が無効になり、同じキーのジョブが同時に実行される可能性があります。

## 保持期間

リトライを受け付ける期間は`failedRetentionMs`、リトライを受け付けない期間は`sweepAfterMs`で指定します。

| 対象                      | 設定                | 既定 |
| ------------------------- | ------------------- | ---- |
| `COMPLETED` / `CANCELLED` | `sweepAfterMs`      | 5分  |
| `FAILED` / `STALLED`      | `failedRetentionMs` | 7日  |

どちらも`bindings`のbinding単位で指定します。

```ts
const tsumugi = defineTsumugi({
  performers,
  bindings: {
    MAIL: { sweepAfterMs: 60 * 60 * 1000, failedRetentionMs: 14 * 24 * 60 * 60 * 1000 },
  },
});
```

一覧そのものの保持はこれとは別の設定で、`retention`で指定します。
cronトリガーを設定すると、期間を過ぎた終了済みのジョブが一覧から削除されます。詳細は[SweepOptions](/reference/config#sweepoptions)を参照してください。

既定では両者の期間が揃っているため、一覧に表示されているジョブはリトライが可能ですが、片方だけ変えた場合には、一覧に表示されていてもリトライを受け付けないジョブが発生してしまう可能性があります。

## 失敗の通知 {#failure-notification}

`onFailure`に通知先のbinding名を指定すると、リトライを使い切ったジョブ(`FAILED`)と、結果が報告されないまま停止したジョブ(`STALLED`)を任意のperformerへ通知できます。

```ts
const tsumugi = defineTsumugi({
  performers,
  onFailure: 'NotifyFailure',
});
```

通知先のperformerは`FailureNotice`を受け取ります。

```ts
import { Performer } from 'tsumugi/performer';
import type { FailureNotice } from 'tsumugi';

export class NotifyFailure extends Performer<FailureNotice, void, {}, Env> {
  async perform(notice: FailureNotice): Promise<void> {
    const res = await fetch(this.env.SLACK_WEBHOOK, {
      method: 'POST',
      body: JSON.stringify({ text: `${notice.binding} が失敗しました: ${notice.error}` }),
    });
    if (!res.ok) throw new Error(`notification failed: ${res.status}`);
  }
}
```

`FailureNotice`が持つ値は以下の通りです。

| 名前          | 内容                                           |
| ------------- | ---------------------------------------------- |
| `jobId`       | 失敗したジョブのID                             |
| `binding`     | 失敗したジョブのbinding                        |
| `state`       | `FAILED`または`STALLED`                        |
| `attempts`    | 実行した回数                                   |
| `maxAttempts` | 試行回数の上限                                 |
| `error`       | 最後の試行が残した理由。記録が無い場合は`null` |
| `runId`       | 投入元のRun。単発で投入したジョブは`null`      |
| `nodeId`      | 投入元のノード。単発で投入したジョブは`null`   |
| `failedAt`    | 失敗した時刻。epoch ms                         |

通知は全てのbindingが対象です。

通知そのものもジョブとして扱われるため、送信に失敗すれば一覧に残り、リトライも可能です。
ただし通知先のbinding自身の失敗は通知されません。これは意図的なものであり、通知が無限に連鎖しないための仕様です。

`onFailure`を指定する前に発生した失敗は通知されません。
