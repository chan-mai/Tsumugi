---
title: Flow
description: 의존 관계를 가진 여러 잡을 방향 비순환 그래프(DAG)로 정의하는 Flow의 정의, fan-out, 조건 분기, 실패 시 동작에 대해 설명합니다
publishedAt: 2026-07-22
updatedAt: 2026-10-25
---

<h1 id="flow">Flow</h1>

Flow는 의존 관계를 가진 여러 잡을 방향 비순환 그래프(DAG)로 정의하는 기능입니다.
Run은 Flow를 1회 실행한 단위입니다.

<h2 id="定義">정의</h2>

`createFlow`는 `performers`를 받아 Flow를 정의하는 함수를 반환합니다.
binding 이름과 payload의 타입은 단독 잡과 마찬가지로 타입 검사됩니다.

```ts
import { createFlow, defineTsumugi } from 'tsumugi';

const performers = { ListNames, Greet, Report };
const flow = createFlow(performers);

const flows = {
  GREETINGS: flow<{ prefix: string }>((f) => {
    const list = f.node('list', 'ListNames', {
      input: (i) => ({ prefix: i.prefix }),
    });

    const each = f.fanOut('greet', 'Greet', {
      after: { list },
      over: (_i, d) => d.list.names,
      input: (name) => ({ name }),
    });

    f.node('report', 'Report', {
      after: { each },
      input: (_i, d) => ({ total: d.each.total, failed: d.each.failed }),
    });
  }),
};

const tsumugi = defineTsumugi({ performers, flows, auth: /* ... */ });
```

`f.node`의 첫 번째 인자에는 노드 ID를, 두 번째 인자에는 binding 이름을 지정합니다.
binding 이름은 [export한 이름](/ko/guide/performer#binding名)과 일치시켜야 합니다.
노드 ID는 영문자, 숫자, 하이픈, 언더스코어로 구성합니다.

`input`에는 Flow의 입력과 이전 단계의 반환값으로 payload를 생성하는 함수를 지정합니다.
두 번째 인자는 `after`에 전달한 객체의 키를 프로퍼티 이름으로 가지는 객체입니다.
생성한 payload가 [상한](/ko/guide/enqueue#enqueue)을 초과하면 해당 노드는 `FAILED`가 됩니다.
노드 정의에는 잡을 투입할 때와 같은 옵션(`maxAttempts`, `backoff`, `timeoutMs`, `priority`, `concurrencyKey` 등)을 선택적으로 지정할 수 있습니다.

<h2 id="開始">시작</h2>

```ts
const runId = await tsumugi.start(env, 'GREETINGS', { prefix: 'hello' });
```

`input`의 타입은 Flow의 타입 인자에서 도출됩니다.
`start`의 네 번째 인자로 `{ id }`를 전달하면 runId가 `<flow>:<id>`로 고정됩니다.
같은 ID로 두 번째 시작을 요청하면 새 Run이 만들어지지 않고 기존 runId가 반환됩니다.
재시도되는 HTTP 핸들러에서 호출해도 Run이 중복되지 않습니다.
네 번째 인자의 `{ deadlineMs }`는 Run 전체의 [기한](#期限)입니다.

<h2 id="fan-out">fan-out</h2>

배열의 요소 수에 따른 병렬 처리는 `f.fanOut`으로 정의합니다.
`over`가 반환하는 요소마다 자식 노드가 하나씩 만들어집니다.
자식 노드의 ID는 요소의 인덱스입니다. 예를 들어 `greet:0`, `greet:1`이 됩니다.
`key`를 전달하면 인덱스 대신 `key`의 반환값이 사용됩니다.
사용할 수 있는 문자는 노드 ID와 같습니다.

후속 노드가 받는 값은 다음 형식의 집계값입니다.

```ts
{ total: 3, succeeded: 2, failed: 1 }
```

자식 노드별 반환값은 후속 노드에 전달되지 않습니다.
개별 결과가 필요하면 performer가 R2나 D1 등에 기록하고, 그 참조를 반환값으로 사용하세요.
자식 노드가 실패해도 fan-out 노드 자체는 실패하지 않습니다.
실패 여부는 후속 노드가 받는 `failed` 값으로 판단합니다.

<h2 id="perform内からのノード追加">perform 내에서 노드 추가</h2>

`ctx.spawn`을 호출하면 실행 중인 노드에 자식 노드가 추가됩니다.

```ts
class Crawl extends Performer<{ url: string }, void, {}, Env> {
  async perform(payload: { url: string }, ctx: JobContext): Promise<void> {
    for (const found of await this.discover(payload.url)) {
      ctx.spawn(found.id, 'CRAWL', { url: found.url });
    }
  }
}
```

첫 번째 인자인 ID는 필수입니다.
자식 노드의 ID는 `<부모의 노드 ID>:<지정한 ID>`로 구성되며, 사용할 수 있는 문자는 노드 ID와 같습니다.
같은 ID로 여러 번 호출해도 자식 노드는 중복해서 만들어지지 않습니다.
`perform`이 실패한 시도에서 추가된 자식 노드는 만들어지지 않습니다.
재실행 시의 `perform`에서 다시 추가하세요.

`spawn`에는 타입 검사가 적용되지 않습니다.
binding 이름과 payload는 런타임 값으로 전달합니다.
다른 Worker의 performer에서 호출하는 경우에는 [`await`가 필요합니다](/ko/guide/performer#別workerに配置した場合の制約).

<h2 id="subflow">subflow</h2>

`f.subflow`는 다른 Flow를 Run으로 시작합니다.
노드는 해당 Run이 종료된 시점에 완료됩니다.

```ts
const REPORTING = flow<{ ids: string[] }>((f) => {
  // ...
});

const PIPELINE = flow<{ prefix: string }>((f) => {
  const list = f.node('list', 'LIST', { input: (i) => ({ prefix: i.prefix }) });
  const reported = f.subflow('report', REPORTING, { input: (_i, d) => ({ ids: d.list.ids }) });
  f.node('notify', 'NOTIFY', { after: { reported }, input: () => ({}) });
});
```

두 번째 인자에는 Flow 정의 자체를 전달합니다.
`input`의 타입은 전달한 Flow의 타입 인자에서 도출됩니다.
시작할 Flow는 `flows`에 등록해야 합니다.
등록하지 않으면 시작 시 에러가 발생합니다.

자식 Run의 runId는 `<자식 Flow 이름>:<부모 runId의 로컬 부분>-<노드 ID>`입니다.
자식 Run의 상태가 그대로 노드의 상태로 반영됩니다.
상태는 `COMPLETED`, `FAILED`, `CANCELLED` 중 하나입니다.
부모 Run을 취소하면 자식 Run도 취소됩니다.

부모 노드는 자식 Run의 반환값을 받지 않습니다.
결과가 필요하면 performer가 R2나 D1 등에 기록합니다.
중첩 상한은 [제약](#制約)을 참조하세요.

<h2 id="待ち合わせ">대기 합류</h2>

노드는 자신과 자손 노드가 모두 종료된 시점에 완료됩니다.
`after`로 지정한 노드에 의존하는 후속 노드는 fan-out의 자식 노드와 `spawn`으로 추가된 자손 노드가 종료된 뒤에 실행됩니다.

<h2 id="実行条件">실행 조건</h2>

기본적으로 의존하는 노드가 모두 성공한 경우에만 노드가 실행됩니다.
`trigger`는 의존하는 노드가 실패했을 때의 동작을 지정합니다.

| 값 | 실행되는 조건 |
| --- | --- |
| `'success'` | 의존하는 노드가 모두 성공. 기본값 |
| `'failure'` | 의존하는 노드 중 하나 이상이 `FAILED`, `STALLED`, `CANCELLED` 중 하나 |
| `'always'` | 의존하는 노드가 모두 종료. 성공 여부는 무관 |

```ts
const flows = {
  BACKUP: flow<{ target: string }>((f) => {
    const dump = f.node('dump', 'DUMP', { input: (i) => ({ target: i.target }) });

    // 실패 시에만 실행
    f.node('alert', 'ALERT', {
      after: { dump },
      trigger: 'failure',
      input: (i) => ({ message: `backup failed: ${i.target}` }),
    });

    // 성공 여부와 관계없이 실행
    f.node('unlock', 'UNLOCK', { after: { dump }, trigger: 'always', input: (i) => ({ target: i.target }) });
  }),
};
```

`after`가 없는 노드에 `trigger`를 지정하면 에러가 발생합니다.
`'failure'` 조건에서 집계하는 대상은 실제로 실패한 노드뿐입니다.
`trigger`나 `when`의 조건을 만족하지 못해 `SKIPPED`가 된 노드는 실패로 집계하지 않습니다.
의존하는 노드가 모두 `SKIPPED`이면 `'failure'` 노드는 실행되지 않습니다.

`'failure'`와 `'always'`에서는 실패한 노드의 반환값이 없습니다.
`input`의 두 번째 인자 타입은 `undefined`를 포함하므로, 값이 없는 경우의 처리를 작성하세요.

```ts
f.node('alert', 'ALERT', {
  after: { dump },
  trigger: 'always',
  // d.dump는 undefined일 수 있음
  input: (_i, d) => ({ size: d.dump?.size ?? 0 }),
});
```

<h2 id="条件分岐">조건 분기</h2>

`when`은 Flow의 입력이나 이전 단계의 결과를 바탕으로 노드의 실행 여부를 결정합니다.
`when`이 `false`를 반환하면 해당 노드는 `SKIPPED`로 전이되고, 의존하는 후속 노드도 실행되지 않습니다.
`when` 안에서 예외가 발생하면 노드는 `FAILED`로 전이됩니다.

```ts
f.node('detail', 'DETAIL', {
  after: { list },
  when: (i, d) => i.verbose && d.list.items.length > 0,
  input: (_i, d) => ({ items: d.list.items }),
});
```

`when`과 `input`을 평가할 때는 인자로 받은 값만 사용하고, 외부에 대한 조회는 하지 마세요.

<h2 id="失敗時の動作">실패 시 동작</h2>

노드가 실패하면 `'success'`로 의존하는 후속 노드는 `SKIPPED`로 전이됩니다.
`trigger`가 `'failure'` 또는 `'always'`인 후속 노드는 실행됩니다.
실패한 노드에 의존하지 않는 노드는 끝까지 실행됩니다.
모든 노드가 종료되면 Run은 `FAILED`로 전이됩니다.

Run이 `FAILED`가 되는 경우는 실패한 노드가 있을 때뿐입니다.
`trigger`나 `when`의 조건 때문에 실행되지 않은 노드는 실패로 집계하지 않습니다.
`trigger: 'failure'` 노드가 성공하더라도 이전 단계의 노드가 실패했다면 Run은 `FAILED`로 종료됩니다.
`SKIPPED`가 된 이유는 노드의 `error`에 기록되며, 대시보드의 Run 상세 화면에 표시됩니다.

`FAILED` 상태의 Run은 대시보드 또는 REST API로 재개합니다.
성공한 노드의 결과는 그대로 사용되고, 그 외의 노드는 미실행 상태로 다시 실행됩니다.
단, fan-out의 자식 노드 중 실행했다가 실패한 자식 노드는 다시 실행되지 않습니다.
그 실패는 fan-out 집계값의 `failed`에 집계된 채로 후속 노드에 계승됩니다.
Run의 기한 초과 또는 노드 수 상한 초과로 중단된 자식 노드는 다시 실행됩니다.

다시 실행되는 노드의 후속에 있는 성공한 노드도 미실행 상태로 다시 실행되며, 그 후속의 후속에도 같은 규칙이 적용됩니다.
이에 따라 `trigger: 'failure'`와 `trigger: 'always'` 노드는 재개 후의 결과에 대해 다시 실행됩니다.
fan-out 노드, subflow 노드, `ctx.spawn`으로 자식 노드를 추가한 노드는 성공했다면 후속에 있더라도 다시 실행되지 않으며 결과가 그대로 사용됩니다.

<h2 id="取り消し">취소</h2>

Run을 취소하면 미실행 노드는 시작되지 않습니다.
실행 중인 노드에는 [취소 요청](/ko/guide/execution#実行中の取り消し)이 전송됩니다.
실행 중인 잡은 중지되지 않습니다.
performer가 요청을 확인하고 종료하거나, 요청 후 `reaperGraceMs`(기본 30초)가 지나도 결과가 보고되지 않으면 Run은 `CANCELLED`로 전이됩니다.

<h2 id="期限">기한</h2>

Run 전체의 기한은 Flow 정의의 두 번째 인자로 지정합니다.

```ts
const GREETINGS = flow<{ prefix: string }>(
  (f) => {
    // ...
  },
  { deadlineMs: 10 * 60 * 1000 },
);
```

`deadlineMs`는 양의 정수(밀리초)로 지정합니다.
`start`의 네 번째 인자로 `{ deadlineMs }`를 전달하면 그 값이 우선합니다.

기한을 넘긴 Run은 취소와 같은 절차로 중단됩니다.
미실행 노드는 `run deadline exceeded` 에러와 함께 `FAILED`로 전이됩니다.
실행 중인 잡은 중지되지 않으며, 그 잡이 종료된 시점에 Run은 `FAILED`로 전이됩니다.
실행 중인 자식 Run은 취소됩니다.

기한까지 종료되지 않은 Run은 남은 노드가 모두 성공하더라도 `FAILED`로 전이됩니다.
기한을 넘겼는지는 Run이 마지막 노드의 종료를 처리한 시각으로 판정하며, 노드가 종료된 시각으로 판정하지 않습니다.
따라서 기한 직전에 마지막 노드가 종료되더라도, Run이 그 종료를 처리하는 시각이 기한을 넘기면 Run은 `FAILED`로 전이됩니다.
이 Run은 일반적인 실패와 마찬가지로 재개 대상입니다.
재개하면 기한은 재개한 시점부터 다시 측정됩니다.

<h2 id="保持期間">보존 기간</h2>

종료된 Run은 `runs.sweepAfterMs`(기본 5분)가 경과한 후 삭제됩니다.
`FAILED` 상태의 Run은 `runs.failedRetentionMs`(기본 7일)가 경과한 후 삭제됩니다.
자세한 내용은 [RunSettings](/ko/reference/config#runsettings)를 참조하세요.

<h2 id="デプロイと実行中のrun">배포와 실행 중인 Run</h2>

실행 중인 Run은 시작 시점의 노드 구성으로 계속 진행됩니다.
`input` 등의 함수를 변경해도 다음에 시작되는 노드부터 반영됩니다.

정의에서 노드를 삭제하면 그 노드를 포함하는 실행 중인 Run은 해당 노드에서 실패합니다.
노드를 삭제할 때는 실행 중인 모든 Run이 종료된 후에 배포하세요.

<h2 id="テスト">테스트</h2>

`simulateFlow`는 지정한 입력에 대한 노드의 실행 순서와 각 노드에 전달되는 payload를 검증합니다.
performer의 실제 처리는 실행되지 않습니다.

```ts
import { simulateFlow } from 'tsumugi/testing';

const result = simulateFlow(flows.GREETINGS, { prefix: 'hello' }, { results: { list: { names: ['a', 'b'] } } });

expect(result.nodes.map((node) => node.id)).toEqual(['list', 'greet:0', 'greet:1', 'greet', 'report']);
expect(result.nodes[1].payload).toEqual({ name: 'a' });
```

각 노드의 반환값은 `results`에 노드 ID를 키로 하여 전달합니다.
값으로는 반환값 자체와, 반환값을 만드는 함수를 모두 사용할 수 있습니다.
전달하지 않은 노드의 반환값은 `undefined`입니다.
`fails`에 전달한 노드는 실패하며, 후속 노드는 `SKIPPED`로 전이됩니다.
Run은 `FAILED`로 전이됩니다.
fan-out의 자식 노드는 `over`의 반환값으로 만들어지지만, `ctx.spawn`으로 추가되는 자식 노드는 포함되지 않습니다.
`simulateFlow`는 subflow 노드의 자식 Flow를 실행하지 않습니다.
subflow 노드의 `payload`는 자식 Run의 입력입니다.
subflow 노드는 `fails`에 지정한 경우를 제외하고 `COMPLETED`가 됩니다.

<h2 id="制約">제약</h2>

노드에서는 `uniqueKey`를 사용할 수 없습니다.
`uniqueKey`를 필수로 요구하는 performer를 노드에 지정하면 타입 에러가 발생합니다.

노드의 반환값이 8,192자를 초과하거나 직렬화할 수 없는 경우 해당 시도는 실패로 처리됩니다.
실패 후에는 `maxAttempts`까지 재시도가 이루어집니다.
큰 결과는 R2 등에 기록하고, 그 참조를 반환값으로 사용하세요.

하나의 Run에 포함할 수 있는 노드 수는 기본적으로 10,000개입니다.
subflow의 중첩은 기본적으로 3단계입니다.
상한은 `defineTsumugi`의 `runs.maxNodes`와 `runs.maxDepth`로 변경합니다.

<h2 id="設定">설정</h2>

`flows`를 지정하는 경우 wrangler 설정에 다음 두 곳을 추가하세요.
지정하지 않는 경우에는 이 설정이 필요하지 않습니다.

```jsonc
{
  "durable_objects": {
    "bindings": [
      { "name": "JOB_SHARD", "class_name": "TsumugiJobShard" },
      { "name": "RUN", "class_name": "TsumugiRun" },
    ],
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["TsumugiJobShard"] },
    { "tag": "v2", "new_sqlite_classes": ["TsumugiRun"] },
  ],
}
```

`TsumugiRun`은 `defineTsumugi`의 반환값에 포함된 `runClass`를 상속하여 export하세요.
D1 마이그레이션은 다시 적용해야 합니다.

```ts
export { TsumugiJobShard } from 'tsumugi';
export class TsumugiRun extends tsumugi.runClass {}
```

```bash
pnpm wrangler d1 migrations apply my-jobs --remote
```
