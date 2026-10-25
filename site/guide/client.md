---
title: 別Workerからの投入
publishedAt: 2026-07-22
updatedAt: 2026-10-25
---

# 別Workerからの投入

performerを持たないWorkerからジョブを投入する場合、`tsumugi/client`の`createClient`を使用してください。
performerを定義したWorkerでは、`defineTsumugi`の戻り値から投入します。

## 使い方

```ts
import { createClient } from 'tsumugi/client';

const jobs = createClient<Env>();

export default {
  async fetch(request, env) {
    const id = await jobs.enqueue(env, {
      binding: 'MAIL',
      payload: { to: 'a@example.com', subject: 'hi' },
    });
    return Response.json({ id });
  },
} satisfies ExportedHandler<Env>;
```

## 必要なbinding

投入するWorkerに設定するbindingは、`JOB_SHARD`に限定されます。
`script_name`には、Tsumugiを設定したWorkerの名前を指定してください。

```jsonc
{
  "durable_objects": {
    "bindings": [
      {
        "name": "JOB_SHARD",
        "class_name": "TsumugiJobShard",
        "script_name": "my-jobs",
      },
    ],
  },
}
```

## 設定の一致

`shards`を2以上に設定したbindingでは、`createClient`にも同じ`shards`を指定してください。

```ts
const jobs = createClient<Env>({
  MAIL: { shards: 4 },
});
```

`policy`と保持期間は、bindingごとにTsumugiを設定したWorkerと同じ値を指定してください。

## 投入時の既定値

`defineTsumugi`に指定した`onEnqueue`は、別Workerからの投入には適用されません。
別Workerからの投入にも同じ既定値を使う場合は、`createClient`の第3引数に同じ関数を指定してください。

```ts
const jobs = createClient<Env>(
  {},
  {},
  { onEnqueue: (input) => (input.binding === 'MAIL' ? { timeoutMs: 120_000 } : undefined) },
);
```

既定値の決まり方は、[投入時の既定値](/guide/execution#投入時の既定値)で説明しています。

## API

| メソッド | 内容 |
| --- | --- |
| `enqueue(env, input)` | 1件のジョブの投入。戻り値はジョブID |
| `enqueueMany(env, inputs)` | 複数のジョブの一括投入 |
| `shardFor(env, binding, partitionKey?)` | 投入先のshardのstubの取得 |

## 型

`tsumugi/client`は、`EnqueueInput`, `EnqueueOptions`, `EnqueueItem`, `JobQueue`, `Performers`, `BindingConfig`, `TsumugiClient`などの型を提供します。

`createClient`の`enqueue`が受け取る`EnqueueInput`では、`binding`は`string`型, `payload`は`unknown`型です。
そのため、bindingごとの型検査とキーの必須化は適用されません。
performerの型を共有している場合は、`JobQueue<M>`に適合するラッパーを作成すると、`defineTsumugi`と同じ型検査が適用されます。
両者の違いは、[投入方法](/guide/enqueue#投入方法)にまとめています。

## REST APIからの投入

Workerを追加せずにジョブを投入する場合は、Tsumugiを設定したWorkerのREST APIにリクエストを送信してください。

```bash
curl -X POST https://my-jobs.example.workers.dev/api/jobs \
  -H "Authorization: Bearer $TSUMUGI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"binding":"MAIL","payload":{"to":"a@example.com","subject":"hi"}}'
```

リクエストの形式は、[REST API](/reference/rest-api#post-apijobs)を参照してください。
