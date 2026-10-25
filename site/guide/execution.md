---
title: 実行の制御
publishedAt: 2026-07-22
updatedAt: 2026-10-25
---

# 実行の制御

## 状態

| 状態 | 意味 |
| --- | --- |
| `SCHEDULED` | 初回とリトライの実行待ち |
| `QUEUED` | 実行対象となり、performerの開始前 |
| `RUNNING` | performerの実行中 |
| `COMPLETED` | 成功。終了状態の1つで、他の状態への遷移なし |
| `FAILED` | 試行回数の上限までの失敗。手動のリトライで`SCHEDULED`に遷移 |
| `CANCELLED` | 取り消し済み。終了状態の1つで、他の状態への遷移なし |
| `STALLED` | 結果が報告されないままの停止。手動のリトライに限り`SCHEDULED`に遷移 |

`attempts`は、終了した試行の回数です。
`SCHEDULED`のジョブは、`attempts`が0の場合は初回の実行待ち、1以上の場合はリトライ待ちです。
`FAILED`と`STALLED`のジョブは、ダッシュボードまたはREST APIから手動でリトライしてください。

### 遷移

`SCHEDULED`のジョブを取り消すと、直ちに`CANCELLED`に遷移します。
`QUEUED`と`RUNNING`のジョブは、期限を過ぎた場合か、[実行中の取り消し](#実行中の取り消し)が確定した場合に、`CANCELLED`に遷移します。

## リトライ

リトライの回数の上限は`maxAttempts`で、間隔は`backoff`で設定します。
`maxAttempts`には、1以上の整数を指定してください。
`backoff`は、固定間隔の`fixed`と指数バックオフの`exponential`のどちらかの形式で指定します。

::callout{type="info"}
wrangler.jsoncの`max_retries`はQueuesの設定です。Tsumugiのリトライには影響しません。
::

### バックオフ

既定は、次の指数バックオフです。

```ts
{ kind: 'exponential', baseMs: 1_000, factor: 2, maxMs: 3_600_000, jitter: true }
```

固定間隔にする場合は、`kind`に`fixed`を指定してください。

```ts
await tsumugi.enqueue(env, {
  binding: 'MAIL',
  payload,
  backoff: { kind: 'fixed', delayMs: 30_000, jitter: true },
});
```

`jitter: true`を指定すると、同時に失敗した多数のジョブの再試行時刻が分散されます。
performer側から再試行の可否と次の再試行の時刻を指定する方法は、[再試行の指定](/guide/performer#再試行の指定)を参照してください。

## 実行保証

`guarantee`は、`at-least-once`(既定)と`at-most-once`のいずれかです。
結果が報告されないジョブの動作は、選択した値により異なります。

| 保証 | 結果が報告されない場合の動作 |
| --- | --- |
| `at-least-once`(既定) | `SCHEDULED`としての再投入 |
| `at-most-once` | 再投入なしの`STALLED`。再実行は手動のリトライに限定 |

```ts
await tsumugi.enqueue(env, {
  binding: 'CHARGE',
  payload,
  guarantee: 'at-most-once',
});
```

`at-most-once`のジョブは、二重に実行されません。
その代わり、実行を開始するまでの時間は、`at-least-once`より長くなります。

## タイムアウトと無応答

`timeoutMs`を過ぎた試行は、失敗として扱われます。
試行のエラーには、`TsumugiTimeoutError`(`job timed out (<jobId>, <timeoutMs>ms)`)が記録されます。
タイムアウト後も、performerの実行は停止されません。
処理を中断する方法は、[タイムアウトによる中断](/guide/performer#タイムアウトによる中断)を参照してください。

`QUEUED`または`RUNNING`のジョブは、実行開始(または最後の`heartbeat`)から`timeoutMs`と`reaperGraceMs`(既定30秒)を過ぎても試行結果が記録されない場合に無応答と判定されます。
`at-most-once`のジョブは、試行回数に関係なく`STALLED`へ遷移します。
`at-least-once`のジョブは、試行回数が上限に達していなければ再投入され、達していれば`FAILED`に遷移します。

## 実行中の取り消し

`QUEUED`と`RUNNING`のジョブを取り消すと、performerへの取り消しの要求が記録されます。
取り消しは、ダッシュボードか[`POST /api/jobs/:id/cancel`](/reference/rest-api#post-apijobsidcancel)で実行します。
このエンドポイントのレスポンスには、`requested: true`が含まれます。

performerは、`ctx.heartbeat()`の戻り値`cancelRequested`で要求を確認します。
処理を中断する場合は、例外をthrowして終了してください。
要求後に失敗した試行はリトライされず、ジョブは`CANCELLED`に遷移します。

```ts
const { cancelRequested } = await ctx.heartbeat(progress);
if (cancelRequested) throw new Error('cancelled');
```

要求より先に成功が報告された場合は、ジョブは`COMPLETED`のままとなり、結果も保存されます。
要求から`reaperGraceMs`(既定30秒)が過ぎても結果が報告されない場合は、ジョブが`CANCELLED`に遷移します。
performerの実行は停止されないため、要求を確認しないperformerは実行を続けます。
`CANCELLED`に遷移した後の報告は、破棄されます。

リトライ待ちのジョブは、再投入されず`CANCELLED`へ遷移します。
実行前の`at-most-once`のジョブも、実行されず`CANCELLED`へ遷移します。
取り消しを要求済みのジョブに`reschedule`を要求すると、REST APIは409で応答します。
`heartbeat`を呼ばないperformerは、要求を確認しません。

## 実行量の制限

bindingごとに、4つの設定で実行量を制限します。

| 設定 | 既定 | 内容 |
| --- | --- | --- |
| `concurrency` | `100` | 同時に実行するジョブ数の上限 |
| `rate` | `null` | 一定時間あたりに実行するジョブ数の上限。`null`は制限なし |
| `perKeyConcurrency` | `1` | `concurrencyKey`ごとの同時実行数の上限 |
| `perKeyRate` | `null` | `concurrencyKey`ごとの一定時間あたりの実行数の上限。`null`は制限なし |

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

`perKeyRate`は、すべてのキーに同じ値で適用されます。
キーごとに異なる値を設定する項目は、用意されていません。
`concurrencyKey`がnullのジョブには、`perKeyConcurrency`と`perKeyRate`が適用されません。

### 実行されない原因の確認

投入したジョブが実行されない場合は、[`GET /api/diagnostics`](/reference/rest-api#get-apidiagnostics)のレスポンスで、実行を制限している設定を確認してください。
レスポンスは、一時停止、同時実行数、レートのどれが原因かを示します。

### 実行時の変更

ダッシュボードの`bindings`タブでは、同時実行数の変更と投入の一時停止を操作します。
変更はデプロイを必要とせず、bindingのすべてのshardに適用されます。
この操作は、[`POST /api/bindings/:binding/policy`](/reference/rest-api#post-apibindingsbindingpolicy)の呼び出しと同様です。

```bash
curl -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"paused": true}' https://example.com/api/bindings/MAIL/policy
```

再開後は、一時停止前から待機していた優先度の低いジョブが、後から投入された優先度の高いジョブより先に実行されることがあります。

![bindingsタブ](/dashboard-bindings.jpg)

コードから変更する場合は、`tsumugi.shardFor`で取得したstubの`configure`を呼び出してください。
`configure`は、`policy`で実行量の設定を、`sweepAfterMs`と`failedRetentionMs`で保持期間を変更します。

```ts
await tsumugi.shardFor(env, 'MAIL').configure({ policy: { concurrency: 5 } });
```

実行時に変更した設定は、`bindings`の設定より優先されます。
その後は、`bindings`の設定は適用されません。
`bindings`の設定に戻すには、[`POST /api/bindings/:binding/policy/reset`](/reference/rest-api#post-apibindingsbindingpolicyreset)を呼び出してください。
あるいは、`configure`で元の内容を再度指定します。

## エージング

優先度の高いジョブが投入され続けると、優先度の低いジョブがいつまでも実行されません。
これを防ぐために、待ち時間に応じて実効優先度が上がります。
この動作をエージングと呼び、既定で適用されます。
上がる間隔は`agingIntervalMs`で、既定値は60秒です。
`null`を指定すると、エージングは適用されず、優先度の順序どおりにジョブが実行されます。

## shard

shardは、bindingのジョブを分割して管理する単位です。
既定のshard数は1です。

```ts
bindings: {
  MAIL: { shards: 4 },
}
```

shard数を2以上にすると、`partitionKey`が必須になり、省略すると例外が発生します。
`concurrencyKey`と`uniqueKey`による制御の範囲は、shard数によって異なります。
shard数が1の場合、binding内のすべてのジョブが対象です。
2以上の場合、`partitionKey`で選ばれる同じshardのジョブに限られます。

`concurrencyKey`または`uniqueKey`を使用する場合は、`partitionKey`にも同じキーを指定してください。
異なる値を設定してもエラーにはなりませんが、同じキーを持つジョブが別々のshardに割り当てられる可能性があります。
その結果、同時実行や重複生成が発生することがあります。

## 保持期間

終了したジョブは、一定期間が経過すると削除されます。

| 対象 | 設定 | 既定 |
| --- | --- | --- |
| `COMPLETED` / `CANCELLED` | `sweepAfterMs` | 5分 |
| `FAILED` / `STALLED` | `failedRetentionMs` | 7日 |

削除済みのジョブは、リトライできません。
両方の設定は、`bindings`でbindingごとに指定します。

```ts
const tsumugi = defineTsumugi({
  performers,
  bindings: {
    MAIL: { sweepAfterMs: 60 * 60 * 1000, failedRetentionMs: 14 * 24 * 60 * 60 * 1000 },
  },
});
```

ダッシュボードとREST APIの一覧に表示する期間は、保持期間とは別に`retention`で設定します。
cronトリガーを設定すると、期間を過ぎた終了済みのジョブとRunが一覧から削除されます。
詳細は[SweepOptions](/reference/config#sweepoptions)を参照してください。

既定では2つの期間が一致します。
そのため、一覧に表示されている`FAILED`と`STALLED`のジョブは、リトライの対象です。
一方の期間だけを変更した場合は、一覧に表示されているジョブでも、リトライの要求に対してREST APIが410で応答する可能性があります。

## 失敗の通知

`onFailure`に通知先のbinding名を指定すると、`FAILED`と`STALLED`のジョブが、指定したperformerに通知されます。
`FAILED`は、試行回数の上限まで失敗したジョブです。
`STALLED`は、結果が報告されないまま停止したジョブです。

```ts
const tsumugi = defineTsumugi({
  performers,
  onFailure: 'NotifyFailure',
});
```

通知先のperformerは、`FailureNotice`を引数として受け取ります。

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

### FailureNotice

| 名前 | 内容 |
| --- | --- |
| `jobId` | 失敗したジョブのID |
| `binding` | 失敗したジョブのbinding |
| `state` | `FAILED`または`STALLED` |
| `attempts` | 実行した回数 |
| `maxAttempts` | 試行回数の上限 |
| `error` | 最後の試行のエラー。記録なしの場合は`null` |
| `runId` | 投入元のRun。単独で投入したジョブは`null` |
| `nodeId` | 投入元のノード。単独で投入したジョブは`null` |
| `failedAt` | 失敗した時刻。epochミリ秒 |

すべてのbindingのジョブが通知の対象です。
通知は1件のジョブとして実行されます。
通知ジョブが失敗した場合、そのジョブは一覧に表示されます。
通知ジョブも他のジョブと同様にリトライの対象です。
通知先のbinding自身のジョブの失敗は通知されません。
`onFailure`を指定する前に失敗したジョブは対象外です。

## 終了の通知

`onSettled`を指定すると、失敗に限らず、終了したジョブが指定したperformerに通知されます。
通知する状態は`states`に指定し、`COMPLETED`, `FAILED`, `CANCELLED`, `STALLED`から選びます。
`states`は必須です。空の配列や不正な状態を指定すると、`defineTsumugi`で例外が発生します。

```ts
const tsumugi = defineTsumugi({
  performers,
  onSettled: {
    binding: 'NotifySettled',
    states: ['COMPLETED', 'FAILED', 'CANCELLED', 'STALLED'],
  },
});
```

`COMPLETED`を含めると、完了したジョブと同じ数の通知ジョブが投入されます。
ジョブの件数を確認してから指定してください。
通知先のperformerは、`SettledNotice`を引数として受け取ります。

### SettledNotice

| 名前 | 内容 |
| --- | --- |
| `jobId` | 終了したジョブのID |
| `binding` | 終了したジョブのbinding |
| `state` | 終了時の状態 |
| `attempts` | 実行した回数 |
| `maxAttempts` | 試行回数の上限 |
| `error` | 最後の試行のエラー。失敗以外の終了と記録なしの場合は`null` |
| `result` | `perform`の戻り値。`COMPLETED`以外と保存上限超過の場合は`null` |
| `runId` | 投入元のRun。単独で投入したジョブは`null` |
| `nodeId` | 投入元のノード。単独で投入したジョブは`null` |
| `settledAt` | 終了した時刻。epochミリ秒 |

通知先のbinding自身のジョブと、`onFailure`の通知先のbindingのジョブは、通知されません。
`onFailure`と同時に指定した場合、`states`に含めた`FAILED`と`STALLED`は、両方の通知先に通知されます。
`onSettled`を指定する前に終了したジョブは、対象外です。

## 投入時の既定値

`onEnqueue`を指定すると、ジョブの投入ごとに`onEnqueue`が呼び出され、その戻り値が実行オプションの既定値として使用されます。
呼び出し側で指定された値は常に優先され、既定値はオプションが明示されていない場合にのみ適用されます。

```ts
const tsumugi = defineTsumugi({
  performers,
  onEnqueue: (input) => (input.binding === 'SlowJob' ? { timeoutMs: 300_000 } : undefined),
});
```

既定値にできる実行オプションは、`traceparent`, `priority`, `maxAttempts`, `backoff`, `timeoutMs`, `guarantee`, `delayMs`, `runAt`, `expiresAt`, `expiresInMs`, `concurrencyKey`です。
`binding`, `payload`, `uniqueKey`, `uniqueForMs`, `partitionKey`は、対象外です。

`onFailure`と`onSettled`の通知ジョブには、`onEnqueue`が適用されません。
別Workerから投入するジョブにも適用する場合は、[`createClient`](/guide/client#投入時の既定値)に同じ関数を渡してください。
