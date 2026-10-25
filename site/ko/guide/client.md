---
title: 다른 Worker에서 enqueue하기
description: performer가 없는 Worker에서 tsumugi/client의 createClient를 사용해 작업을 enqueue하는 방법
publishedAt: 2026-07-22
updatedAt: 2026-10-25
---

<h1 id="別workerからの投入">다른 Worker에서 enqueue하기</h1>

performer가 없는 Worker에서 작업을 enqueue하려면 `tsumugi/client`의 `createClient`를 사용하세요.
performer를 정의한 Worker에서는 `defineTsumugi`의 반환값으로 enqueue합니다.

<h2 id="使い方">사용 방법</h2>

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

<h2 id="必要なbinding">필요한 binding</h2>

enqueue하는 Worker에 설정하는 binding은 `JOB_SHARD`로 한정됩니다.
`script_name`에는 Tsumugi를 설정한 Worker의 이름을 지정하세요.

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

<h2 id="設定の一致">설정 일치</h2>

`shards`를 2 이상으로 설정한 binding에서는 `createClient`에도 같은 `shards`를 지정하세요.

```ts
const jobs = createClient<Env>({
  MAIL: { shards: 4 },
});
```

`policy`와 보존 기간은 binding별로 Tsumugi를 설정한 Worker와 같은 값을 지정하세요.

<h2 id="投入時の既定値">enqueue 시 기본값</h2>

`defineTsumugi`에 지정한 `onEnqueue`는 다른 Worker에서 하는 enqueue에는 적용되지 않습니다.
다른 Worker에서 enqueue할 때도 같은 기본값을 사용하려면 `createClient`의 세 번째 인자에 같은 함수를 지정하세요.

```ts
const jobs = createClient<Env>(
  {},
  {},
  { onEnqueue: (input) => (input.binding === 'MAIL' ? { timeoutMs: 120_000 } : undefined) },
);
```

기본값이 결정되는 방식은 [enqueue 시 기본값](/ko/guide/execution#投入時の既定値)에서 설명합니다.

<h2 id="api">API</h2>

| 메서드 | 내용 |
| --- | --- |
| `enqueue(env, input)` | 작업 1건을 enqueue합니다. 반환값은 작업 ID입니다 |
| `enqueueMany(env, inputs)` | 여러 작업을 한 번에 enqueue합니다 |
| `shardFor(env, binding, partitionKey?)` | enqueue 대상 shard의 stub을 가져옵니다 |

<h2 id="型">타입</h2>

`tsumugi/client`는 `EnqueueInput`, `EnqueueOptions`, `EnqueueItem`, `JobQueue`, `Performers`, `BindingConfig`, `TsumugiClient` 등의 타입을 제공합니다.

`createClient`의 `enqueue`가 받는 `EnqueueInput`에서 `binding`은 `string` 타입이고 `payload`는 `unknown` 타입입니다.
따라서 binding별 타입 검사와 키 필수화는 적용되지 않습니다.
performer의 타입을 공유하고 있다면 `JobQueue<M>`에 맞는 래퍼를 작성해 `defineTsumugi`와 같은 타입 검사를 적용할 수 있습니다.
두 방식의 차이는 [enqueue 방법](/ko/guide/enqueue#投入方法)에 정리되어 있습니다.

<h2 id="rest-apiからの投入">REST API로 enqueue하기</h2>

Worker를 추가하지 않고 작업을 enqueue하려면 Tsumugi를 설정한 Worker의 REST API로 요청을 보내세요.

```bash
curl -X POST https://my-jobs.example.workers.dev/api/jobs \
  -H "Authorization: Bearer $TSUMUGI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"binding":"MAIL","payload":{"to":"a@example.com","subject":"hi"}}'
```

요청 형식은 [REST API](/ko/reference/rest-api#post-apijobs)를 참조하세요.
