# 別Workerからの投入

ジョブの投入のみを行い実行はしないWorkerでは、`tsumugi/client`を使用します

Durable Objectの実装を参照しないため、投入側のWorkerのバンドルには含まれません

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

必要なbindingは`JOB_SHARD`のみです。ジョブ管理Worker本体と同じDurable Objectを指定します

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

`script_name`にはDurable Objectを定義しているWorkerの名前を指定します
D1とQueuesとAnalytics Engineは不要です

## 設定を揃える

`shards`を2以上に設定している場合、投入側にも同じ設定が必要です
分割数が一致しない場合、投入先のDurable Objectが変わるためです

```ts
const jobs = createClient<Env>({
  MAIL: { shards: 4 },
});
```

`policy`と保持期間もここで指定します。本体と同じ値を指定してください

## API

| メソッド                                | 内容                                           |
| --------------------------------------- | ---------------------------------------------- |
| `enqueue(env, input)`                   | 1件投入してジョブIDを返す                          |
| `enqueueMany(env, inputs)`              | 複数件を宛先のDurable Objectごとにまとめて投入する  |
| `shardFor(env, binding, partitionKey?)` | 対象のDurable Objectのstubを直接取得する           |

`enqueueMany`は宛先ごとに集約するため、件数が増えても往復の回数は増えません
`enqueue`を逐次で呼び出すと件数に比例して遅くなります

## REST APIからの投入

Workerを追加しない場合は、ジョブ管理Worker本体のREST APIを呼び出す方法もあります

```bash
curl -X POST https://my-jobs.example.workers.dev/api/jobs \
  -H "Authorization: Bearer $TSUMUGI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"binding":"MAIL","payload":{"to":"a@example.com","subject":"hi"}}'
```

詳しくは[REST API](/reference/rest-api)を参照してください
