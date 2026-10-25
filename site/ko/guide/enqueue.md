---
title: 잡 투입
description: enqueue, enqueueMany, jobs를 사용한 잡 투입 방법과 예약 실행, 유효 기간, 중복 제거, 직렬화 등 투입 시 옵션에 대해
publishedAt: 2026-07-22
updatedAt: 2026-10-25
---

<h1 id="ジョブの投入">잡 투입</h1>

<h2 id="投入方法">투입 방법</h2>

| 방법 | 타입 | shard 수와 실행량 설정을 가져오는 곳 |
| --- | --- | --- |
| `tsumugi.enqueue` / `tsumugi.jobs(env)` | binding별로 도출되는 payload와 필수 키의 타입 | `defineTsumugi`의 `bindings` |
| `createClient(bindings)` | `binding`은 `string`, `payload`는 `unknown` | `createClient`의 첫 번째 인자 |

performer와 같은 Worker에서는 `defineTsumugi`의 반환값을 사용해 잡을 투입합니다.
`createClient`는 performer를 가지지 않는 Worker에서 잡을 투입하기 위한 클라이언트입니다.

필요한 binding이 부족하면 `tsumugi.enqueue`, `tsumugi.enqueueMany`, `tsumugi.jobs(env)`는 예외를 발생시킵니다.
예외에는 부족한 binding의 목록이 포함됩니다.
`JOB_SHARD`, `TSUMUGI_DB`, `TSUMUGI_QUEUE`는 항상 필수입니다.
`flows`를 사용하는 경우에는 `RUN`을, `schedules`를 사용하는 경우에는 `SCHEDULER`를 추가합니다.
`remote()` performer에는 대응하는 Service Binding을 준비합니다.

<h2 id="enqueue">enqueue</h2>

```ts
const id = await tsumugi.enqueue(env, {
  binding: 'MAIL',
  payload: { to: 'a@example.com', subject: 'hi' },
});
```

반환값은 잡 ID입니다.
payload의 타입은 지정한 `binding`의 값에서 도출됩니다.
필수 키를 지정하지 않으면 컴파일 오류가 발생합니다.

<h2 id="enqueuemany">enqueueMany</h2>

`tsumugi.enqueueMany`는 여러 잡을 한꺼번에 투입합니다.

```ts
const ids = await tsumugi.enqueueMany(env, [
  { binding: 'MAIL', payload: { to: 'a@example.com', subject: 'hi' } },
  { binding: 'MAIL', payload: { to: 'b@example.com', subject: 'hi' } },
]);
```

건수가 늘어나도 소요 시간은 거의 변하지 않습니다.
반환되는 배열에서 i번째 요소는 입력의 i번째 잡에 대응하는 ID입니다.

<h2 id="jobs">jobs</h2>

`tsumugi.jobs(env)`의 반환값은 `env`를 미리 지정해 둔, 타입이 지정된 잡 투입용 객체입니다.

```ts
const jobs = tsumugi.jobs(env);

const id = await jobs.enqueue('MAIL', { to: 'a@example.com', subject: 'hi' });
await jobs.enqueue('CHARGE', { customerId: 'c1', amountJpy: 1200 }, { concurrencyKey: 'customer:c1' });
```

투입되는 내용은 `tsumugi.enqueue`와 동일합니다.
차이는 인자의 형식뿐입니다.
[키를 필수로 지정한 performer](/ko/guide/performer#キーの必須化)에서는 `options`를 생략한 경우와 키를 지정하지 않은 경우 모두 컴파일 오류가 발생합니다.

<h2 id="オプション">옵션</h2>

| 이름 | 기본값 | 내용 |
| --- | --- | --- |
| `priority` | `0` | 숫자 우선순위. 클수록 먼저 실행 |
| `maxAttempts` | `3` | 시도 횟수의 상한. 1 이상의 정수 |
| `backoff` | 지수, 1초부터 시작, 계수 2, 상한 1시간, 지터 있음 | 재시도 간격 |
| `timeoutMs` | `60000` | 타임아웃까지의 시간 |
| `delayMs` | 없음 | 실행 시작까지의 지연. `runAt`과 동시에 지정 불가 |
| `runAt` | 없음 | 실행 시작 시각. `delayMs`와 동시에 지정 불가 |
| `expiresInMs` | 없음 | 투입 시각부터 계산한 유효 기간 |
| `expiresAt` | 없음 | 유효 기간의 만료 시각. `expiresInMs`보다 우선 |
| `guarantee` | `at-least-once` | 실행 보장. 중복 실행을 피하려면 `at-most-once` |
| `concurrencyKey` | 없음 | 같은 키의 잡을 순서대로 실행하기 위한 키 |
| `uniqueKey` | 없음 | 중복 제거용 키 |
| `uniqueForMs` | 24시간 | `uniqueKey`로 중복을 판정하는 기간 |
| `partitionKey` | 없음 | shard를 분할한 경우 투입 대상을 정하는 키 |
| `traceparent` | 없음 | 투입 측의 W3C Trace Context |

shard 수가 2 이상인 binding에서 `partitionKey`를 생략하면 예외가 발생합니다.
`partitionKey`로 투입 대상 shard를 선택하는 것은 `bindings`의 `shards`를 적용하는 투입 방법으로 한정됩니다.
자세한 내용은 [투입 방법](#投入方法)을 참조하십시오.

<h2 id="予約実行">예약 실행</h2>

```ts
// 1시간 후
await tsumugi.enqueue(env, { binding: 'MAIL', payload, delayMs: 60 * 60 * 1000 });

// 지정 시각
await tsumugi.enqueue(env, { binding: 'MAIL', payload, runAt: Date.parse('2026-08-01T09:00:00+09:00') });
```

<h2 id="有効期限">유효 기간</h2>

`expiresInMs` 또는 `expiresAt`을 지정하면 기한이 지난 잡은 실행되지 않고 `CANCELLED`로 전이됩니다.
일시 정지나 실행 지연 이후에도 기한이 만료된 알림이 한꺼번에 실행되는 일은 없습니다.

```ts
// 5분 이내에 시작하지 못하면 실행하지 않음
await tsumugi.enqueue(env, { binding: 'NOTIFY', payload, expiresInMs: 5 * 60 * 1000 });
```

실행 중인 잡은 기한이 지나도 중단되지 않습니다.
다음 재시도 예정 시각이 기한보다 늦은 경우, 잡은 실패 시 `CANCELLED`로 전이됩니다.
`FAILED` 및 `STALLED` 상태의 잡을 수동으로 재시도할 때도 기한이 적용됩니다.

<h2 id="重複排除">중복 제거</h2>

`uniqueKey`를 지정하면 같은 키의 잡이 이미 존재할 때 새 잡을 생성하지 않습니다.
이때의 반환값은 기존 잡의 ID입니다.

```ts
const id = await tsumugi.enqueue(env, {
  binding: 'SYNC',
  payload: { sku: 'X-1' },
  uniqueKey: 'sku:X-1',
});
```

중복된 투입은 오류가 되지 않습니다.
예외도 발생하지 않습니다.
`uniqueForMs`의 기간이 지나면 중복 판정이 해제됩니다.
같은 키로 다시 투입하면 새 잡이 생성됩니다.

<h2 id="直列化">직렬화</h2>

`concurrencyKey`가 같은 잡은 `perKeyConcurrency`의 건수까지 동시에 실행됩니다.
기본값은 1이므로 같은 키의 잡은 한 건씩 순서대로 실행됩니다.

```ts
await tsumugi.enqueue(env, {
  binding: 'CHARGE',
  payload: { customerId: 'c1', amountJpy: 1200 },
  concurrencyKey: 'customer:c1',
});
```

shard 수가 2 이상인 binding에서는 이 직렬화가 `partitionKey`가 같은 shard 안으로 한정됩니다.
자세한 내용은 [shard](/ko/guide/execution#shard)를 참조하십시오.

<h2 id="トレース情報">트레이스 정보</h2>

투입 시 `traceparent`를 지정하면 performer의 `ctx.traceparent`에 같은 값이 전달됩니다.
재시도 시에도 같은 값이 전달되며, 대시보드는 잡의 상세 화면에 이 값을 표시합니다.
`enqueueMany`는 잡별 `traceparent`를 받습니다.

```ts
await tsumugi.enqueue(env, {
  binding: 'MAIL',
  payload: { to: 'a@example.com', subject: 'hi' },
  traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
});
```

형식은 W3C Trace Context의 version `00`(55자)입니다.
각 항목은 소문자 16진수로 기술합니다.
형식이 올바르지 않은 값을 지정하면 투입 시 검증 오류가 발생합니다.
trace-id 또는 parent-id의 모든 자리가 0인 값을 지정한 경우에도 검증 오류가 발생합니다.

<h2 id="ジョブid">잡 ID</h2>

```
<binding>#<shard>:<localId>
```

예: `MAIL#0:xxxxxxxxxxxxxxxxxxxxxxxx`

shard 수를 변경해도 기존 잡 ID는 동일한 잡을 식별합니다.
다만 변경 전후로 `partitionKey` 값이 같은 잡의 투입 대상 shard가 달라질 수 있습니다.
`concurrencyKey`와 `uniqueKey`에 의한 제어는 shard별로 실행되므로, 투입 대상 shard가 다른 잡 사이에는 적용되지 않습니다.
shard 수를 줄이면 범위 밖이 된 shard에는 [실행 시 설정 변경](/ko/guide/execution#実行時の変更)이 적용되지 않습니다.
shard에 대한 자세한 내용은 [shard](/ko/guide/execution#shard)를 참조하십시오.

<h2 id="別workerからの投入">다른 Worker에서의 투입</h2>

performer를 가지지 않는 Worker에서의 투입에 대해서는 [다른 Worker에서의 투입](/ko/guide/client)을 참조하십시오.
