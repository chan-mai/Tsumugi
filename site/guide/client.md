# 別Workerからの投入

ジョブの投入のみを行うWorkerでは、`tsumugi/client`を使用します。


## 使用方法

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

必要なbindingは`JOB_SHARD`のみで、ジョブ管理Workerと同じDurable Objectを指定する必要があります。

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

## 設定を揃える

`shards`を2以上に設定している場合、投入側にも同じ設定が必要になります。

```ts
const jobs = createClient<Env>({
  MAIL: { shards: 4 },
});
```

`policy`と保持期間もここで指定可能です。本体側と同じ値を指定してください。

## 投入時の既定値

第3引数に`onEnqueue`を含めることにより、投入のたびに実行オプションの既定値を付与できます。
本体の`defineTsumugi`に指定したフックは別Workerからの投入には適用されないため、必要な場合は同じフックを指定してください


```ts
const jobs = createClient<Env>(
  {},
  {},
  { onEnqueue: (input) => (input.binding === 'MAIL' ? { timeoutMs: 120_000 } : undefined) },
);
```

動作の詳細は[投入時の既定値](/guide/execution#enqueue-hook)を参照してください。

## API

| メソッド                                | 内容                                     |
| --------------------------------------- | ---------------------------------------- |
| `enqueue(env, input)`                   | 1件投入してジョブIDを返す                |
| `enqueueMany(env, inputs)`              | 複数件をまとめて投入する                 |
| `shardFor(env, binding, partitionKey?)` | 対象のDurable Objectのstubを直接取得する |

`enqueueMany`は件数が増えても所要時間がほとんど変わりません。
`enqueue`を逐次で呼び出すと件数に比例して遅くなります。

## 型

`tsumugi/client`からは`EnqueueInput` `EnqueueOptions` `EnqueueItem` `JobQueue` `Performers` `BindingConfig` `TsumugiClient`などの型を参照可能です。

`createClient`が受け取るのは`EnqueueInput`で、`binding`は`string`、`payload`は`unknown`のみが許容されます。
bindingごとの型と必須キーの強制は適用されません。詳細は[投入経路](/guide/enqueue#paths)を参照してください。
performerの型を共有できる場合、`JobQueue<M>`に適合するラッパーを利用側で用意すると同じ強制を適用することができます。

## REST APIからの投入

Workerを追加しない(できない)場合、ジョブ管理Worker本体のREST APIを呼び出すことでジョブを投入することができます。

```bash
curl -X POST https://my-jobs.example.workers.dev/api/jobs \
  -H "Authorization: Bearer $TSUMUGI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"binding":"MAIL","payload":{"to":"a@example.com","subject":"hi"}}'
```

詳細は[REST API](/reference/rest-api)を参照してください。
