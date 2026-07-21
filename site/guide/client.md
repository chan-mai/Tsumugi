# 別Workerからの投入

ジョブを入れるだけで実行はしないWorkerからは、`tsumugi/client`を使います

Durable Object実装を参照しないので、そちらのWorkerのバンドルには含まれません

## 使いかた

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

`JOB_SHARD`だけです。ジョブ管理Worker本体と同じDurable Objectを指します

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

`script_name`にはDurable Objectを定義しているWorkerの名前を書きます
D1もQueuesもAnalytics Engineも不要です

## 設定を揃える

`shards`を2以上にしている場合、投入側も同じ設定を知っている必要があります
分割数が食い違うと投入先のDurable Objectがずれるためです

```ts
const jobs = createClient<Env>({
  MAIL: { shards: 4 },
});
```

`policy`や保持期間もここで渡せます
これらはDurable Objectに投入時の設定として送られるので、本体と同じ値を書いておきます

## API

| メソッド                                | 内容                                           |
| --------------------------------------- | ---------------------------------------------- |
| `enqueue(env, input)`                   | 1件入れてジョブIDを返す                        |
| `enqueueMany(env, inputs)`              | 複数件を宛先Durable Objectごとにまとめて入れる |
| `shardFor(env, binding, partitionKey?)` | 対象Durable Objectのstubを直接引く             |

`enqueueMany`は宛先ごとに集約するので、件数が増えても往復は増えません
`enqueue`を逐次で回すと78件/秒あたりでDurable Objectのソフト上限に律速されます

## REST APIから入れる

Workerを足さずに済ませたい場合は、ジョブ管理Worker本体のREST APIを呼ぶ方法もあります

```bash
curl -X POST https://my-jobs.example.workers.dev/api/jobs \
  -H "Authorization: Bearer $TSUMUGI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"binding":"MAIL","payload":{"to":"a@example.com","subject":"hi"}}'
```

詳しくは[REST API](/reference/rest-api)を参照してください
