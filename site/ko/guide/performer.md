---
title: Performer
description: 잡 처리를 정의하는 Performer의 실행 컨텍스트, 실패와 재시도, 다른 Worker로의 배치, 테스트에 대해 설명합니다
publishedAt: 2026-07-22
updatedAt: 2026-10-25
---

<h1 id="performer">Performer</h1>

잡 처리는 `Performer`를 상속한 클래스로 정의합니다.

<h2 id="基本形">기본 형태</h2>

```ts
import { Performer, type JobContext } from 'tsumugi/performer';

export class SendMail extends Performer<{ to: string; subject: string }, void, {}, Env> {
  async perform(payload: { to: string; subject: string }, ctx: JobContext): Promise<void> {
    const remaining = ctx.deadlineAt - Date.now();
    await fetch('https://api.example.com/mail', {
      method: 'POST',
      body: JSON.stringify(payload),
      // 기한 초과 시 즉시 중단
      signal: remaining > 0 ? AbortSignal.timeout(remaining) : AbortSignal.abort(),
    });
  }
}
```

타입 인자는 순서대로 payload, 반환값, 필수 키 선언, `Env`입니다.
performer 안에서는 `this.env`로 Worker의 binding을 참조합니다.

<h2 id="binding名">binding 이름</h2>

binding 이름은 Worker의 엔트리에서 export한 이름입니다.
`export class SendMail`의 경우 binding 이름은 `SendMail`이 되며, 별도로 등록할 필요가 없습니다.

```ts
// src/index.ts
export { SendMail } from './performers/send-mail.js';
```

`defineTsumugi`의 `performers`에는 performer를 모아 둔 모듈을 그대로 전달합니다.
binding별 payload와 필수 키의 타입은 이 `performers`에서 도출됩니다.
`performers`의 키는 Worker의 엔트리에서 export한 이름과 일치시켜야 합니다.

```ts
import * as performers from './performers/index.js';

export * from './performers/index.js';

const tsumugi = defineTsumugi({ performers, /* ... */ });
```

binding 이름을 별칭으로 지정하려면, performer를 모아서 export하는 파일에서 별칭을 붙이십시오.

```ts
// src/performers/index.ts
export { SendMail as MAIL } from './send-mail.js';
```

Worker의 엔트리에서 별칭을 붙이면 실행 시 binding 이름은 `MAIL`이 됩니다.
이때 `performers`의 키는 `SendMail` 그대로이므로 둘이 일치하지 않습니다.
별칭은 Worker의 엔트리에서 붙이지 마십시오.

```ts
// src/index.ts
// 실행 시 export만 변경되며, 타입상의 binding 이름은 일치하지 않음
export { SendMail as MAIL } from './performers/send-mail.js';
```

<h2 id="実行コンテキスト">실행 컨텍스트</h2>

`perform`의 두 번째 인자로 `JobContext`가 전달됩니다.

| 필드 | 내용 |
| --- | --- |
| `jobId` | 잡 ID |
| `attempt` | 시도 횟수. 첫 실행은 1 |
| `idempotencyKey` | 잡마다 일정한 값. 재실행해도 같은 값 |
| `deadlineAt` | 타임아웃 시각. epoch 밀리초 |
| `heartbeat` | 실행 중임을 보고하는 함수 |
| `log` | 처리 도중의 메시지를 저장하는 비동기 함수 |
| `traceparent` | enqueue 시 지정한 트레이스 정보. 지정하지 않은 경우 `null` |
| `spawn` | 실행 중인 Flow의 node에 자식 node를 추가하는 함수 |
| `fail` | 실패한 시도의 재시도 여부를 지정하는 함수(사용법은 「재시도 지정」 참조) |

`at-least-once`에서는 같은 잡이 여러 번 실행될 수 있다는 점을 전제로 해야 합니다.
외부에 대한 부작용은 `idempotencyKey`를 이용해 멱등성을 보장합니다.

<h3 id="タイムアウトによる中断">타임아웃에 의한 중단</h3>

처리를 타임아웃으로 중단하려면 `deadlineAt`에서 `AbortSignal`을 만들어 처리에 전달합니다.
기한이 이미 지났다면 `AbortSignal.abort()`를 사용하십시오.

```ts
const remaining = ctx.deadlineAt - Date.now();
const signal = remaining > 0 ? AbortSignal.timeout(remaining) : AbortSignal.abort();
```

Tsumugi는 기한이 지난 performer의 실행을 자동으로 중지하지 않습니다.
`deadlineAt`을 사용해 중단을 구현하지 않은 performer는 기한이 지난 뒤에도 계속 실행될 수 있습니다.

<h3 id="heartbeat">heartbeat</h3>

소요 시간이 입력에 따라 크게 달라지는 처리에서는 `timeoutMs`를 가장 긴 소요 시간에 맞춰 설정해야 합니다.
`ctx.heartbeat()`를 호출하면 타임아웃의 기점이 마지막으로 보고된 시각으로 갱신됩니다.
따라서 `timeoutMs`는 보고 간격을 기준으로 한 값으로 설정하십시오.

```ts
class Import extends Performer<{ rows: string[] }, void, {}, Env> {
  async perform(payload: { rows: string[] }, ctx: JobContext): Promise<void> {
    for (const [index, row] of payload.rows.entries()) {
      await store(row);
      await ctx.heartbeat((index + 1) / payload.rows.length);
    }
  }
}
```

인자인 진행률은 0 이상 1 이하의 숫자입니다.
범위를 벗어난 값은 범위 안으로 보정되며, 숫자가 아닌 값은 진행률 없는 보고로 처리됩니다.
보고한 진행률은 대시보드의 잡 상세 화면에 표시됩니다.
직전 보고로부터 5초 이내에 호출하면 보고가 전송되지 않습니다.
보고에 실패해도 예외로 통지되지 않습니다.
반환값은 `{ cancelRequested: boolean }`이며, 취소가 요청되었는지를 나타내는 값입니다.
한 번 `true`가 된 이후에는 이후 호출의 반환값도 `true`입니다.
취소 동작의 자세한 내용은 [실행 중 취소](/ko/guide/execution#実行中の取り消し) 절에 있습니다.

<h3 id="ログ">로그</h3>

`ctx.log(message)`는 처리 도중의 메시지를 저장합니다.
호출할 때는 `await`가 필요합니다.

```ts
await ctx.log('Import started');
await importRows(payload.rows);
await ctx.log('Import completed');
```

대시보드는 저장된 로그를 잡 상세 화면에 시도 횟수, 기록 시각, 본문과 함께 표시합니다.
이후 performer가 비정상 종료되더라도 저장된 로그는 삭제되지 않습니다.
저장되는 로그는 잡 하나당 최신 20건입니다.
본문은 JavaScript 문자열 길이로 최대 2,000자입니다.
초과한 부분은 잘려 나갑니다.
직전 저장으로부터 1초 이내에 호출하면 로그가 저장되지 않습니다.
저장에 실패하면 `console.error`로 출력되며, 잡 처리는 계속됩니다.

<h3 id="トレース情報">트레이스 정보</h3>

`ctx.traceparent`는 enqueue 시 지정한 `traceparent` 값이며, 지정하지 않은 경우 `null`입니다.
재시도할 때도 enqueue 시와 같은 값입니다.
트레이스 SDK를 사용하는 경우 `ctx.traceparent`를 부모 컨텍스트로 삼아 span을 만들어야 합니다.
enqueue 시 지정하는 형식과 `spawn`의 사용 방법은 각각 [잡 enqueue](/ko/guide/enqueue#トレース情報)와 [Flow](/ko/guide/flow#perform内からのノード追加)를 참조하십시오.

<h2 id="失敗とリトライ">실패와 재시도</h2>

잡이 실패하면 예외가 발생합니다.
시도 횟수가 상한에 도달하지 않았다면 재시도가 실행됩니다.

```ts
class ChargeCard extends Performer<{ customerId: string; amountJpy: number }, void, { concurrencyKey: true }, Env> {
  async perform(payload: { customerId: string; amountJpy: number }): Promise<void> {
    const res = await this.env.PAYMENT.charge(payload);
    if (!res.ok) throw new Error(`payment failed: ${res.status}`);
  }
}
```

예외 메시지는 시도 이력에 저장되며, 대시보드는 잡 상세 화면에 시도 이력을 표시합니다.
저장 상한은 메시지가 2,000자, 시도 이력이 잡 하나당 20건입니다.
반환값이 8,192자를 넘거나 직렬화할 수 없는 경우 반환값은 저장되지 않습니다.
Flow의 node에서의 처리 방식은 [Flow](/ko/guide/flow#制約)를 참조하십시오.

<h3 id="再試行の指定">재시도 지정</h3>

`ctx.fail()`을 호출한 뒤 예외를 던지면, 그 시도의 후속 재시도에 `ctx.fail()`로 지정한 내용이 적용됩니다.
`{ retry: false }`를 지정하면 시도 횟수가 상한에 도달하지 않았더라도 잡은 재시도되지 않고 `FAILED`로 전이됩니다.
이 지정은 다시 시도해도 결과가 바뀌지 않는 실패에 사용하십시오.

```ts
class SyncUser extends Performer<{ userId: string }, void, {}, Env> {
  async perform(payload: { userId: string }, ctx: JobContext): Promise<void> {
    const res = await fetch(`https://api.example.com/users/${payload.userId}`);
    if (res.status === 404) {
      await ctx.fail({ retry: false });
      throw new Error(`user not found: ${payload.userId}`);
    }
  }
}
```

`{ retryAt }`에 epoch 밀리초를 지정하면, 그 시도에 한해 `backoff`로 계산한 간격 대신 지정한 시각에 재시도됩니다.
다음 예는 `Retry-After` 헤더의 값(초 단위 숫자 또는 HTTP-date)을 시각으로 변환합니다.

```ts
if (res.status === 429) {
  const header = res.headers.get('Retry-After') ?? '';
  const date = Date.parse(header);
  // 해석할 수 없는 경우 60초 후
  const retryAt = /^\d+$/.test(header)
    ? Date.now() + Number(header) * 1_000
    : Number.isNaN(date)
      ? Date.now() + 60_000
      : date;
  await ctx.fail({ retryAt });
  throw new Error('rate limited');
}
```

`retryAt`을 지정해도 그 시도는 시도 횟수에 포함됩니다.
`maxAttempts`에 도달한 경우 잡은 `FAILED`로 전이됩니다.
지정한 시각이 기한(`expiresAt`)보다 늦은 경우 잡은 `CANCELLED`로 전이됩니다.
과거 시각을 지정하면 즉시 재시도 대상이 됩니다.
`ctx.fail()`의 지정은 throw로 종료된 시도에만 적용됩니다.
throw하지 않고 `perform`이 종료되면, `ctx.fail()`을 호출했더라도 잡은 완료됩니다.
한 번의 시도에서 `ctx.fail()`을 여러 번 호출한 경우 마지막 지정이 유효합니다.
잘못된 형식의 값을 `ctx.fail()`에 전달하면 그 호출에서 예외가 발생합니다.

<h2 id="キーの必須化">키 필수화</h2>

세 번째 타입 인자에 `{ concurrencyKey: true }` 또는 `{ uniqueKey: true }`를 지정한 performer에서는 enqueue 시 키 지정이 필수입니다.

```ts
class ChargeCard extends Performer<Payload, void, { concurrencyKey: true }, Env> {}
```

키는 enqueue 시 문자열로 전달합니다.
Tsumugi는 performer 쪽에서 키를 도출하는 함수를 정의하는 방식을 제공하지 않습니다.
`tsumugi.enqueue` 및 `tsumugi.jobs(env)`에서는 키를 지정하지 않으면 컴파일 시 오류가 발생합니다.

```ts
await tsumugi.enqueue(env, { binding: 'CHARGE', payload, concurrencyKey: 'customer:c1' });
await tsumugi.jobs(env).enqueue('CHARGE', payload, { concurrencyKey: 'customer:c1' });
```

::callout{type="warning"}
`createClient()`에는 키 필수화가 적용되지 않습니다.
자세한 내용은 [enqueue 방법](/ko/guide/enqueue#投入方法)을 참조하십시오.
::

<h2 id="別workerへの配置">다른 Worker로의 배치</h2>

performer는 Service Binding으로 연결한 다른 Worker에 배치하더라도 Tsumugi에서 실행됩니다.

```ts
// performer를 배치하는 Worker
import { Performer, type JobContext } from 'tsumugi/performer';

export class SendMail extends Performer<{ to: string; subject: string }, void, {}, Env> {
  async perform(payload: { to: string; subject: string }, ctx: JobContext): Promise<void> {
    // ...
  }
}

// WorkerEntrypoint의 named export 외에 default도 필요
export default {
  async fetch(): Promise<Response> {
    return new Response('performer only', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

호출 측의 wrangler.jsonc에는 binding 이름과 entrypoint를 대응시키는 Service Binding을 설정해야 합니다.

```jsonc
"services": [
  { "binding": "MAIL", "service": "my-mailer", "entrypoint": "SendMail" },
],
```

호출 측의 `performers`에는 클래스 대신 `remote()`를 지정하십시오.
같은 Worker의 performer와 다른 Worker의 performer를 하나의 `performers`에 함께 두는 구성도 지원합니다.

```ts
import { remote } from 'tsumugi';
import type { SendMail } from 'my-mailer';

const performers = { ...local, MAIL: remote<SendMail>() };
```

<h3 id="別workerに配置した場合の制約">다른 Worker에 배치한 경우의 제약</h3>

다른 Worker에 배치된 performer에서는 `ctx.spawn`과 `ctx.fail`을 호출할 때 `await`가 필요합니다.
`ctx.spawn`을 `await`하지 않고 `perform`이 종료되면 자식 node 추가가 반영되지 않습니다.
`ctx.fail`을 `await`하지 않고 예외를 throw한 경우에도 지정이 반영되지 않을 수 있습니다.

```ts
await ctx.spawn('child', 'MAIL', payload);
```

`spawn`으로 추가한 자식 node는 `perform`이 완료된 뒤에 생성됩니다.
`spawn`을 호출한 시점에는 자식 node가 실행되지 않습니다.

<h2 id="テスト">테스트</h2>

`tsumugi/testing`의 `runPerformer`는 잡을 enqueue하지 않고 performer를 직접 호출합니다.
`Performer`의 생성자는 `WorkerEntrypoint`와 같은 `(ctx, env)` 두 인자를 받습니다.

```ts
import { createTestContext, runPerformer } from 'tsumugi/testing';

declare const ctx: ExecutionContext;
declare const env: Env;

const result = await runPerformer(new SendWelcome(ctx, env), { userId: 'u_1' });

if (result.ok) console.log(result.value);
else console.error(result.error);
```

`this.env`를 사용하지 않는 performer에서는 `runPerformer`가 `perform`을 가진 일반 객체도 받을 수 있습니다.
`runPerformer`는 예외를 다시 던지지 않으며, 성공과 실패 모두 같은 형식의 결과를 반환값으로 돌려줍니다.
`createTestContext()`가 반환하는 컨텍스트는 `ctx.fail()`에 전달된 지정을 호출 순서대로 `fails`에 기록합니다.

<h3 id="実行コンテキストの差し替え">실행 컨텍스트 교체</h3>

`createTestContext`에 값을 지정하면 `runPerformer`에 전달하는 실행 컨텍스트의 항목을 교체할 수 있습니다.
다음 예는 시도 횟수를 3회째로 설정합니다.

```ts
const ctx = createTestContext({ attempt: 3 });
await runPerformer(performer, payload, ctx);
```

기한에 대한 performer의 동작을 검증하려면 `deadlineAt`에 과거 시각 또는 가까운 미래의 시각을 지정합니다.

```ts
const ctx = createTestContext({ deadlineAt: Date.now() + 50 });
await runPerformer(performer, payload, ctx);
```

<h3 id="投入から実行までのテスト">enqueue부터 실행까지의 테스트</h3>

잡을 enqueue하고 실행하기까지의 일련의 흐름을 검증하려면 `@cloudflare/vitest-pool-workers`를 이용하십시오.
`tsumugi/testing`은 이 범위의 테스트를 대상으로 하지 않습니다.
