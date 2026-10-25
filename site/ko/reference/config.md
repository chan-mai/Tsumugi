---
title: 설정
description: defineTsumugi에 지정하는 설정 항목의 타입과 기본값, wrangler의 binding 설정에 대해
publishedAt: 2026-07-22
updatedAt: 2026-10-25
---

<h1 id="設定">설정</h1>

<h2 id="definetsumugi">defineTsumugi</h2>

```ts
const tsumugi = defineTsumugi({
  performers,
  flows,
  schedules,
  runs,
  bindings,
  auth,
  ui,
  retention,
  metrics,
  onFailure,
  onSettled,
  onEnqueue,
});
```

`defineTsumugi`에는 타입 인자를 지정할 필요가 없습니다.
binding별 payload 타입과 `Env`는 `performers`의 내용에서 자동으로 추론됩니다.

| 이름 | 필수 | 내용 |
| --- | --- | --- |
| `performers` | ○ | performer 모듈. payload와 필수 키 타입의 출처 |
| `flows` |  | Flow 이름과 정의의 대응. 지정하는 경우 `RUN` binding이 필요 |
| `schedules` |  | 정기 실행 정의. 지정하는 경우 `SCHEDULER` binding이 필요 |
| `runs` |  | Run의 상한과 보관 기간 |
| `bindings` |  | binding별 shard 수, 실행량 제한, 보관 기간 |
| `auth` |  | 인증. 미설정 시 REST API와 대시보드로 가는 모든 요청이 404 |
| `ui` |  | `tsumugi/ui`의 `ui()`. 미지정 시 대시보드 번들 없음 |
| `retention` |  | 목록의 보관 기간 |
| `metrics` |  | 메트릭 읽기 설정. 미설정 시 `GET /api/metrics`가 501 |
| `onFailure` |  | 실패한 잡을 알리는 binding 이름. 미설정 시 알림 없음 |
| `onSettled` |  | 종료된 잡을 알리는 binding 이름과 알림 대상 상태 |
| `onEnqueue` |  | enqueue할 때마다 실행 옵션의 기본값을 설정하는 함수 |

<h3 id="戻り値">반환값</h3>

| 이름 | 내용 |
| --- | --- |
| `fetch`, `queue`, `scheduled` | default export에 포함하는 `ExportedHandler`의 핸들러 |
| `jobs(env)` | 타입이 지정된 enqueue 객체(`JobQueue<M>`) |
| `enqueue(env, input)` | 잡 1건의 타입이 지정된 enqueue. 반환값은 잡 ID |
| `enqueueMany(env, inputs)` | `enqueue`와 같은 형식으로 여러 잡을 enqueue |
| `shardFor(env, binding, partitionKey?)` | enqueue 대상 shard의 stub |
| `start(env, flow, input, options?)` | Run 시작. 반환값은 runId |
| `runFor(env, runId)` | Run의 stub |
| `runClass` | wrangler에 등록하는 Run의 클래스 |
| `schedulerClass` | wrangler에 등록하는 정기 실행의 클래스 |

`flows`를 지정하지 않은 경우에도 반환값에는 `start`, `runFor`, `runClass`가 포함됩니다.
`flows`에 정의되지 않은 Flow 이름을 `start`에 전달하면 예외가 발생합니다.
`RUN` binding이 없는 상태에서 `runFor`를 호출한 경우에도 마찬가지로 예외가 발생합니다.
enqueue 방법별 차이는 [잡 enqueue](/ko/guide/enqueue#投入方法)를 참조하십시오.

<h2 id="auth">auth</h2>

| 함수 | 내용 |
| --- | --- |
| `bearerAuth` | 토큰 하나를 사용하는 인증 |
| `cloudflareAccess` | Cloudflare Access JWT 검증 |
| `unsafeNoAuth` | 인증 없음 |

임의의 Hono 미들웨어도 `auth`에 지정하는 값으로 받아들입니다.
`auth`를 설정하지 않으면 REST API와 대시보드로 가는 모든 요청에 404로 응답합니다.
`unsafeNoAuth`의 영향은 [대시보드와 인증](/ko/guide/dashboard#認証しない構成)을 참조하십시오.

<h2 id="metrics">metrics</h2>

```ts
const tsumugi = defineTsumugi({
  performers,
  auth: bearerAuth((env: Env) => env.TSUMUGI_TOKEN),
  metrics: (env: Env) =>
    env.CF_ACCOUNT_ID && env.CF_API_TOKEN
      ? { accountId: env.CF_ACCOUNT_ID, apiToken: env.CF_API_TOKEN, dataset: 'tsumugi_jobs' }
      : undefined,
});
```

`metrics`는 기록한 메트릭을 대시보드와 REST API에서 조회하기 위한 설정입니다.
`apiToken`은 Account Analytics 읽기 권한을 가진 API 토큰이며, Secret으로 설정하십시오.
`dataset`은 wrangler 설정 파일의 `analytics_engine_datasets`에 기술한 데이터셋 이름입니다.
`metrics`를 지정하지 않으면 `GET /api/metrics`는 501로 응답하고, 대시보드 사이드바에 메트릭 항목이 표시되지 않습니다.

<h2 id="onfailure">onFailure</h2>

```ts
const tsumugi = defineTsumugi({
  performers,
  onFailure: 'NotifyFailure',
});
```

`onFailure`는 실패한 잡을 알리는 performer의 binding 이름입니다.
알림 대상 performer는 `FailureNotice`를 받는 것으로 한정됩니다.
알림 조건과 `FailureNotice`의 내용은 [실패 알림](/ko/guide/execution#失敗の通知)을 참조하십시오.

<h2 id="onsettled">onSettled</h2>

```ts
const tsumugi = defineTsumugi({
  performers,
  onSettled: { binding: 'NotifySettled', states: ['COMPLETED', 'FAILED'] },
});
```

`onSettled`는 종료된 잡을 알리는 performer의 binding 이름과 알림 대상 상태입니다.
`binding`은 `SettledNotice`를 받는 performer로 한정됩니다.
`states`는 필수이며, `COMPLETED`, `FAILED`, `CANCELLED`, `STALLED` 중에서 선택합니다.
빈 배열이나 잘못된 상태를 지정하면 `defineTsumugi`에서 예외가 발생합니다.
알림 조건과 `SettledNotice`의 내용은 [종료 알림](/ko/guide/execution#終了の通知)을 참조하십시오.

<h2 id="onenqueue">onEnqueue</h2>

```ts
const tsumugi = defineTsumugi({
  performers,
  onEnqueue: (input) => (input.binding === 'SlowJob' ? { timeoutMs: 300_000 } : undefined),
});
```

`onEnqueue`는 잡을 enqueue할 때마다 실행 옵션의 기본값을 설정하는 함수입니다.
사용자가 명시한 값은 항상 우선합니다.
대상이 되는 enqueue 방법과 기본값이 적용되는 옵션의 자세한 내용은 [enqueue 시 기본값](/ko/guide/execution#投入時の既定値)을 참조하십시오.

<h2 id="runsettings">RunSettings</h2>

| 이름 | 기본값 | 내용 |
| --- | --- | --- |
| `maxNodes` | `10000` | 하나의 Run에 포함할 수 있는 node 수의 상한. 초과 시 Run이 실패 |
| `maxDepth` | `3` | subflow 중첩의 상한. 초과 시 Run이 실패 |
| `sweepAfterMs` | 5분 | 종료된 Run의 보관 시간 |
| `failedRetentionMs` | 7일 | `FAILED` Run의 보관 시간. 이 기간 내의 Run은 재개 대상 |

<h2 id="bindingconfig">BindingConfig</h2>

| 이름 | 기본값 | 내용 |
| --- | --- | --- |
| `shards` | `1` | shard 수. 2 이상에서는 `partitionKey`가 필수 |
| `policy` | 아래 참조 | 실행량 제한과 에이징 |
| `sweepAfterMs` | 5분 | `COMPLETED`와 `CANCELLED` 잡의 보관 시간 |
| `failedRetentionMs` | 7일 | `FAILED`와 `STALLED` 잡의 보관 시간. 이 기간 내의 잡은 재시도 대상 |

<h2 id="policy">Policy</h2>

| 이름 | 기본값 | 내용 |
| --- | --- | --- |
| `paused` | `false` | enqueue 일시 중지 |
| `concurrency` | `100` | 동시 실행 수의 상한 |
| `perKeyConcurrency` | `1` | `concurrencyKey`별 동시 실행 수의 상한 |
| `rate` | `null` | `{ tokens, intervalMs }`. `intervalMs`당 `tokens`건까지 실행 |
| `perKeyRate` | `null` | `{ tokens, intervalMs }`. 키별로 `intervalMs`당 `tokens`건까지 실행 |
| `agingIntervalMs` | `60000` | 실효 우선순위가 1 올라가기까지의 대기 시간. `null`은 에이징 없음 |
| `reaperGraceMs` | `30000` | `timeoutMs`가 경과한 후, 결과가 보고되지 않은 잡을 무응답으로 판정하기까지의 유예 |

<h2 id="enqueueinput">EnqueueInput</h2>

| 이름 | 기본값 | 내용 |
| --- | --- | --- |
| `binding` |  | enqueue 대상 binding 이름 |
| `payload` |  | performer에 전달하는 값 |
| `priority` | `0` | 숫자 우선순위. 클수록 먼저 실행 |
| `maxAttempts` | `3` | 시도 횟수의 상한 |
| `backoff` | 지수 | `fixed` 또는 `exponential` |
| `timeoutMs` | `60000` | 타임아웃까지의 시간 |
| `delayMs` |  | 실행 시작까지의 지연 |
| `runAt` |  | 실행 시작 시각. `delayMs`와 동시에 지정할 수 없음 |
| `expiresInMs` |  | enqueue 시각부터 센 만료 기한 |
| `expiresAt` |  | 만료 시각. `expiresInMs`보다 우선 |
| `guarantee` | `at-least-once` | `at-least-once` 또는 `at-most-once` |
| `concurrencyKey` |  | 같은 키의 잡을 순서대로 실행하기 위한 키 |
| `uniqueKey` |  | 중복 제거 키 |
| `uniqueForMs` | 24시간 | `uniqueKey`로 중복을 판정하는 기간 |
| `partitionKey` |  | shard를 분할한 경우 enqueue 대상을 결정하는 키 |

옵션의 자세한 내용은 [잡 enqueue](/ko/guide/enqueue#オプション)를 참조하십시오.

`createClient`의 `enqueue`는 `EnqueueInput`을 인자로 받습니다.
`defineTsumugi`의 `enqueue`가 받는 입력에서는 `binding`별로 payload와 필수 키의 타입이 도출됩니다.

<h3 id="backoffの既定値">backoff의 기본값</h3>

```ts
{ kind: 'exponential', baseMs: 1_000, factor: 2, maxMs: 3_600_000, jitter: true }
```

<h2 id="sweepoptions">SweepOptions</h2>

| 이름 | 기본값 | 내용 |
| --- | --- | --- |
| `olderThanMs` | 7일 | 종료된 잡과 Run을 목록에 남기는 시간 |
| `limit` | `1000` | 1회에 삭제하는 건수의 상한. 잡과 Run 각각의 건수 |

cron 트리거를 설정하면 `olderThanMs`가 경과한 후 종료된 잡과 Run이 목록에서 삭제됩니다.

Run을 재개할 수 있는 기간은 `runs`에서 설정합니다.
`FAILED` Run은 `olderThanMs`와 `runs.failedRetentionMs` 중 긴 쪽의 기간이 경과한 후 목록에서 삭제됩니다.
`FAILED`와 `STALLED` 잡도 `olderThanMs`와 binding의 `failedRetentionMs` 중 긴 쪽의 기간이 경과한 후 목록에서 삭제됩니다.

<h2 id="wranglerのbinding">wrangler의 binding</h2>

| binding | 종류 | 필수 | 용도 |
| --- | --- | --- | --- |
| `JOB_SHARD` | Durable Object | ○ | 잡 관리 |
| `RUN` | Durable Object |  | Run 관리. `flows`를 사용하는 경우 필요 |
| `SCHEDULER` | Durable Object |  | 정기 실행. `schedules`를 사용하는 경우 필요 |
| `TSUMUGI_DB` | D1 | ○ | 목록과 검색 |
| `TSUMUGI_QUEUE` | Queues | ○ | performer 실행 |
| `TSUMUGI_METRICS` | Analytics Engine |  | 메트릭 기록 |

`TSUMUGI_METRICS`가 없으면 메트릭은 기록되지 않습니다.
그 밖의 동작은 변하지 않습니다.
다른 필수 binding이 부족하면 REST API는 503으로 응답하고, 부족한 binding의 목록이 본문에 포함됩니다.

`remote()`를 지정한 performer에는 Service Binding이 필요합니다.
binding 이름에는 고정된 이름을 사용하지 않고 `performers`의 키를 그대로 지정합니다.

```jsonc
"services": [
  { "binding": "MAIL", "service": "my-mailer", "entrypoint": "SendMail" },
]
```

performer 없이 잡 enqueue에만 사용하는 Worker에 필요한 binding은 `JOB_SHARD`뿐입니다.

<h2 id="サブパス">서브패스</h2>

| import 경로 | 내용 |
| --- | --- |
| `tsumugi` | `defineTsumugi`, `enqueue`, `bearerAuth`, `TsumugiJobShard` 등 |
| `tsumugi/performer` | `Performer` |
| `tsumugi/client` | `createClient`와 관련 타입 |
| `tsumugi/ui` | `ui()` |
| `tsumugi/types` | 타입 전용 |
| `tsumugi/testing` | `runPerformer`, `createTestContext`, `simulateFlow` 등 |

공개된 npm 패키지는 `tsumugi`입니다.
설정용 CLI는 `npx tsumugi`로 실행합니다.
명령 목록은 [CLI](/ko/reference/cli)를 참조하십시오.
