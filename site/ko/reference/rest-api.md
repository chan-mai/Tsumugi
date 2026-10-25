---
title: REST API
description: 작업, Run, 정기 실행, 실행량 설정을 조작하는 REST API의 엔드포인트와 요청 및 응답 형식에 대해
publishedAt: 2026-07-22
updatedAt: 2026-10-25
---

<h1 id="rest-api">REST API</h1>

`auth`를 설정하면 Tsumugi는 `/api` 이하 엔드포인트로 들어오는 요청을 처리합니다.
설정하지 않은 경우 모든 요청에 404로 응답합니다.
인증은 `/api/*`에만 적용됩니다.
대시보드의 HTML은 작업 데이터를 포함하지 않으므로 인증을 요구하지 않고 제공됩니다.
대시보드는 인증되지 않은 경우 토큰 입력란을 표시합니다.
OpenAPI 정의는 [`GET /api/openapi.json`](#get-apiopenapijson)으로 가져옵니다.

<h2 id="共通のレスポンス">공통 응답</h2>

| 상태 | 의미 |
| --- | --- |
| 401 | 인증 실패 |
| 501 | 해당 조작이 구성되지 않은 상태 |
| 503 | 구성이 완료되지 않은 상태 또는 일시적으로 사용할 수 없는 상태 |

503의 본문에는 이유가 포함됩니다.
적용되지 않은 마이그레이션이 있는 경우 미적용 파일 이름이 본문에 포함됩니다.
binding이 부족한 경우 부족한 binding 목록이 본문에 포함됩니다.
일시적으로 사용할 수 없는 경우에는 잠시 후 다시 시도하세요.

Flow를 등록하지 않은 구성에서는 Run의 시작, 재개, 취소 엔드포인트가 501로 응답합니다.
`/api/openapi.json`은 구성이 완료되지 않아도 응답합니다.
runId 형식이 올바르지 않으면 `/api/runs/:id`를 포함한 엔드포인트는 400으로 응답합니다.

<h2 id="ジョブ">작업</h2>

<h3 id="get-apijobs">GET /api/jobs</h3>

작업 목록을 가져옵니다.
응답은 작업 배열과 전체 건수를 포함합니다.

<h4 id="クエリパラメータ">쿼리 파라미터</h4>

| 이름 | 기본값 | 내용 |
| --- | --- | --- |
| `state` | 없음 | 상태로 필터링 |
| `binding` | 없음 | binding 이름으로 필터링 |
| `id` | 없음 | 작업 ID 완전 일치 |
| `unique_key` | 없음 | `uniqueKey` 완전 일치 |
| `concurrency_key` | 없음 | `concurrencyKey` 완전 일치 |
| `created_from` | 없음 | `created_at`의 하한. epoch 밀리초이며 해당 값을 포함 |
| `created_to` | 없음 | `created_at`의 상한. epoch 밀리초이며 해당 값을 포함 |
| `limit` | `20` | 최대 100 |
| `offset` | `0` | 가져오기 시작 위치 |
| `sort` | `updated_at` | `updated_at`, `created_at`, `binding`, `state`, `priority`, `attempts` 중 하나 |
| `order` | `desc` | `asc`를 지정한 경우에만 오름차순 |

여러 조건을 지정한 경우 모든 조건을 만족하는 작업이 목록에 포함됩니다.
키 검색은 완전 일치이며 부분 일치는 사용할 수 없습니다.
`sort`와 `order`에 올바르지 않은 값을 지정한 경우 400이 아니라 기본 정렬 순서로 응답합니다.
`created_from`과 `created_to`에 정수가 아닌 값을 지정한 경우 해당 조건은 무시됩니다.

```json
{
  "jobs": [
    {
      "id": "MAIL#0:xxxxxxxxxxxxxxxxxxxxxxxx",
      "binding": "MAIL",
      "state": "FAILED",
      "priority": 0,
      "attempts": 3,
      "max_attempts": 3,
      "created_at": 1753000000000,
      "updated_at": 1753000060000,
      "dispatched_at": 1753000030000,
      "retryable": true
    }
  ],
  "total": 1
}
```

`retryable`은 보존 기간을 기준으로 계산한 참고값입니다.
재시도 가능 여부는 재시도를 요청할 때 판정됩니다.
보존 기간이 지난 작업을 재시도하면 410으로 응답합니다.

<h3 id="get-apijobsid">GET /api/jobs/:id</h3>

작업 1건의 상세 정보를 가져옵니다.
작업을 찾을 수 없는 경우 404로 응답합니다.

```json
{
  "job": {
    "id": "MAIL#0:xxxxxxxxxxxxxxxxxxxxxxxx",
    "binding": "MAIL",
    "state": "FAILED",
    "payload": "{\"to\":\"a@example.com\"}",
    "result": null,
    "priority": 0,
    "attempts": 3,
    "max_attempts": 3,
    "progress": null,
    "concurrency_key": "domain:example.com",
    "unique_key": null,
    "guarantee": "at-least-once",
    "created_at": 1753000000000,
    "updated_at": 1753000060000,
    "dispatched_at": 1753000030000,
    "run_after": null,
    "expires_at": null,
    "cancel_requested_at": null,
    "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    "retryable": true,
    "logs": [
      {
        "attempt": 1,
        "timestamp": 1753000011000,
        "message": "Payment requested"
      }
    ],
    "attempts_log": [
      {
        "attempt": 1,
        "state": "FAILED",
        "started_at": 1753000010000,
        "finished_at": 1753000012000,
        "error": "payment failed: 502"
      }
    ]
  }
}
```

| 항목 | 내용 |
| --- | --- |
| `result` | `perform`의 반환값. 성공이 아닌 경우 `null` |
| `run_after` | 예약한 작업의 실행 예정 시각 |
| `expires_at` | 실행 시작 기한. 기한이 지난 작업은 실행되지 않고 `CANCELLED`로 전환 |
| `cancel_requested_at` | [실행 중 취소](/ko/guide/execution#実行中の取り消し)를 요청한 시각. 요청이 없으면 `null` |
| `attempts_log` | 시도 이력. 최근 시도부터 순서대로 |
| `logs` | `ctx.log()`로 저장한 로그. 수신 순서이며 각 항목은 시도 횟수, 기록 시각(epoch 밀리초), 본문. 로그가 없으면 빈 배열. 건수와 본문 길이의 상한은 [로그](/ko/guide/performer#ログ)를 참조 |
| `traceparent` | 투입 시 지정한 트레이스 정보. 지정하지 않았으면 `null` |

<h3 id="post-apijobs">POST /api/jobs</h3>

작업을 투입합니다.
요청 본문은 다음 형식의 JSON입니다.

```json
{
  "binding": "MAIL",
  "payload": { "to": "a@example.com", "subject": "hi" },
  "maxAttempts": 5,
  "delayMs": 60000,
  "expiresInMs": 600000,
  "priority": 10,
  "concurrencyKey": "domain:example.com",
  "uniqueKey": "mail:a@example.com:hi",
  "partitionKey": "tenant-42",
  "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
}
```

`binding`과 `payload`는 필수이며, `performers`에 등록된 binding을 지정합니다.
`maxAttempts`, `delayMs`, `expiresInMs`, `priority`는 정수로 지정하세요.
위 예시에 없는 항목(`timeoutMs`, `backoff` 등)은 무시되며 기본값이 사용됩니다.

`expiresInMs`는 작업 투입 시각부터 계산한 실행 기한입니다.
기한이 지난 작업은 실행되지 않고 `CANCELLED`로 전환됩니다.
`partitionKey`는 `shards`를 2 이상으로 설정한 binding에서 투입할 shard를 결정하기 위한 키이며, 해당 binding에서는 필수입니다.

`traceparent`는 선택 사항입니다.
본문에서 지정하지 않으면 `traceparent` 헤더의 값이 사용되고, 둘 다 지정한 경우 본문의 값이 우선합니다.
값에는 [작업 투입](/ko/guide/enqueue#トレース情報)에서 설명하는 W3C Trace Context version `00` 형식을 사용하세요.
지정한 값은 재시도할 때도 이어지며 performer의 `ctx.traceparent`로 전달됩니다.

`uniqueKey`가 기존 작업과 같은 경우에도 201로 응답하며, 새 작업은 만들어지지 않고 본문에는 기존 작업 ID가 포함됩니다.

| 상태 | 의미 |
| --- | --- |
| 201 | 생성됨. 본문은 `{ "id": "..." }` |
| 400 | 잘못된 JSON 또는 검증 실패(등록되지 않은 binding, 정수가 아닌 값, 잘못된 `traceparent`) |

<h3 id="post-apijobsidretry">POST /api/jobs/:id/retry</h3>

`FAILED` 또는 `STALLED` 상태의 작업을 `SCHEDULED` 상태로 전환합니다.
보존 기간이 지나 삭제된 작업은 재시도할 수 없습니다.

| 상태 | 의미 |
| --- | --- |
| 200 | 재시도됨 |
| 400 | 잘못된 작업 ID 형식 |
| 409 | 작업 상태가 `FAILED`도 `STALLED`도 아닌 상태 |
| 410 | 존재하지 않는 작업 또는 보존 기간이 지나 삭제된 작업 |

409인 경우 작업 상태가 바뀐 뒤에 다시 요청하세요.

<h3 id="post-apijobsidcancel">POST /api/jobs/:id/cancel</h3>

작업을 취소합니다.
대상은 `SCHEDULED`, `QUEUED`, `RUNNING` 상태의 작업입니다.

`SCHEDULED` 작업은 즉시 `CANCELLED`로 전환됩니다.
`QUEUED`와 `RUNNING` 작업은 이미 실행 중일 수 있으므로 취소 요청으로 기록됩니다.
이 경우 응답에 `requested: true`가 포함됩니다.
작업은 performer가 요청을 확인하고 종료한 경우, 또는 요청 후 `reaperGraceMs`(기본 30초)가 지나도 결과가 보고되지 않은 경우에 `CANCELLED`로 전환됩니다.
자세한 내용은 [실행 중 취소](/ko/guide/execution#実行中の取り消し)를 참조하세요.

```json
{ "ok": true, "requested": true }
```

이미 취소를 요청한 작업에 다시 요청한 경우에도 `requested: true`로 응답합니다.
종료된 작업에 대한 요청에는 409로 응답합니다.
그 밖의 응답은 `retry`와 같습니다.

<h3 id="post-apijobsbulk-retry">POST /api/jobs/bulk-retry</h3>

<h3 id="post-apijobsbulk-cancel">POST /api/jobs/bulk-cancel</h3>

여러 작업을 한꺼번에 재시도하거나 취소합니다.
대상은 작업 ID 배열 또는 필터 조건 중 하나로 지정합니다.

작업 ID로 지정하는 경우 `ids`를 지정하고, 필터 조건으로 지정하는 경우 `ids`를 생략합니다.

```json
{ "ids": ["MAIL#0:xxxxxxxxxxxxxxxxxxxxxxxx", "MAIL#0:yyyyyyyyyyyyyyyyyyyyyyyy"] }
```

```json
{ "binding": "MAIL", "state": "FAILED", "created_from": 1753000000000, "limit": 200 }
```

| 항목 | 필수 | 설명 |
| --- | --- | --- |
| `ids` | 선택 | 작업 ID 배열. 1건 이상 200건 이하 |
| `binding` | 선택 | binding 이름으로 필터링 |
| `state` | 선택 | `bulk-retry`는 `FAILED`, `STALLED`. `bulk-cancel`은 `SCHEDULED`, `QUEUED`, `RUNNING` |
| `unique_key` | 선택 | 완전 일치 |
| `concurrency_key` | 선택 | 완전 일치 |
| `created_from` | 선택 | `created_at`의 하한 |
| `created_to` | 선택 | `created_at`의 상한 |
| `limit` | 선택 | 한 번에 처리할 건수. 1 이상, 기본값과 최댓값은 모두 200 |

`ids`를 지정한 경우 다른 조건은 무시됩니다.
`created_from`, `created_to`, `limit`에는 정수를 지정하세요.

조건에서 `state`를 생략하면 `bulk-retry`의 대상은 `FAILED`와 `STALLED` 작업이고, `bulk-cancel`의 대상은 `SCHEDULED`, `QUEUED`, `RUNNING` 작업입니다.
이 외의 상태를 지정한 경우 400으로 응답합니다.
`bulk-retry`에서는 `failedRetentionMs`가 지난 작업이 대상에서 제외됩니다.
`bulk-cancel`에서는 이미 취소를 요청한 작업이 `CANCELLED`로 확정될 때까지 대상에서 제외됩니다.
`ids`로 작업을 직접 지정한 경우에는 이미 요청한 작업에 다시 요청해도 이중으로 처리되지 않습니다.

```json
{
  "ok": ["MAIL#0:xxxxxxxxxxxxxxxxxxxxxxxx"],
  "failed": [{ "id": "MAIL#0:yyyyyyyyyyyyyyyyyyyyyyyy", "reason": "gone" }],
  "remaining": 320
}
```

일부 작업의 처리에 실패한 경우에도 상태 코드는 200입니다.
`bulk-cancel`에서는 취소 요청으로 기록된 작업도 `ok`에 포함됩니다.
`failed`의 `reason`은 작업별 재시도 및 취소 엔드포인트가 응답하는 오류에 대응합니다.
`invalid-state`와 `gone`은 각각 409와 410에 해당합니다.
`ids`에 작업 ID로 올바르지 않은 값이 포함된 경우 해당 값은 `invalid-id`로 `failed`에 포함됩니다.

`remaining`은 조건으로 지정했을 때 `limit`을 넘어 처리되지 않은 건수입니다.
0이 될 때까지 같은 요청을 다시 보내세요.
`ids`로 지정한 경우 `remaining`은 항상 0입니다.
요청 시점에 조건에 맞지 않는 작업은 목록에 표시되어 있더라도 `failed`에 포함됩니다.

<h3 id="post-apijobsidreschedule">POST /api/jobs/:id/reschedule</h3>

예약한 작업의 실행 시각을 변경합니다.
대상은 `SCHEDULED` 작업입니다.

```json
{ "runAt": 1753003600000, "priority": 10 }
```

| 항목 | 필수 | 설명 |
| --- | --- | --- |
| `runAt` | 조건부 | 절대 시각. `delayMs`와 동시에 지정할 수 없음 |
| `delayMs` | 조건부 | 현재 시각 기준 상대값. `runAt`과 동시에 지정할 수 없음 |
| `priority` | 선택 | 함께 변경하는 경우에 지정 |

`runAt`과 `delayMs` 중 하나만 지정하세요.
둘 다 지정한 경우와 둘 다 지정하지 않은 경우에는 400으로 응답합니다.
`runAt`, `delayMs`, `priority`는 정수로 지정하세요.

작업 ID는 바뀌지 않습니다.
`uniqueKey`에 의한 중복 판정도 계속 유지됩니다.
상태 코드는 `retry`와 같습니다.

<h2 id="集計と診断">집계와 진단</h2>

<h3 id="get-apistats">GET /api/stats</h3>

상태별 건수를 가져옵니다.

```json
{
  "byState": { "SCHEDULED": 12, "RUNNING": 3, "COMPLETED": 480, "FAILED": 2 },
  "oldestScheduledMs": 45000
}
```

`oldestScheduledMs`는 가장 오래된 `SCHEDULED` 작업이 투입된 후 경과한 시간을 밀리초로 나타냅니다.
`SCHEDULED` 작업이 없으면 값은 `null`입니다.

<h3 id="get-apimetrics">GET /api/metrics</h3>

기록된 메트릭을 바탕으로 binding별 실패율과 소요 시간을 가져옵니다.

<h4 id="クエリパラメータ-1">쿼리 파라미터</h4>

| 이름 | 기본값 | 내용 |
| --- | --- | --- |
| `hours` | `24` | 집계할 시간. 1 이상 720 이하의 정수 |
| `binding` | 없음 | binding 이름으로 필터링 |

```json
{
  "hours": 24,
  "bindings": [
    {
      "binding": "MAIL",
      "total": 1200,
      "failed": 18,
      "failureRate": 0.015,
      "avgDurationMs": 820,
      "maxDurationMs": 5400,
      "p95DurationMs": 2100,
      "avgAttempts": 1.04
    }
  ],
  "series": [{ "at": 1753000000000, "total": 50, "failed": 1, "avgDurationMs": 810 }]
}
```

메트릭이 샘플링되는 기간에도 실제 건수에 가까운 값이 포함됩니다.
`hours`가 범위를 벗어난 경우와 `binding`이 올바르지 않은 이름인 경우 400으로 응답합니다.
`metrics`를 설정하지 않은 구성에서는 501로 응답합니다.
502는 메트릭을 가져오지 못한 경우의 응답이며 본문에 이유가 포함됩니다.

<h3 id="get-apidiagnostics">GET /api/diagnostics</h3>

binding별로 실행 대기 중인 작업이 실행되지 않는 원인을 가져옵니다.
실행 중인 작업의 건수와 현재 실행량 설정도 포함됩니다.

```json
{
  "bindings": {
    "MAIL": {
      "active": 2,
      "blocked": { "paused": false, "capacity": true, "tokens": false, "perKey": false, "perKeyTokens": false },
      "policy": {
        "paused": false,
        "concurrency": 100,
        "perKeyConcurrency": 1,
        "rate": null,
        "perKeyRate": null,
        "agingIntervalMs": 60000,
        "reaperGraceMs": 30000
      }
    }
  }
}
```

| 항목 | 의미 |
| --- | --- |
| `active` | 실행 중인 작업의 건수 |
| `blocked` | 실행 대기 중인 작업의 실행을 제한하는 설정 |
| `policy` | 현재 적용 중인 실행량 설정 |

<h4 id="blocked">blocked</h4>

| 항목 | 제한 |
| --- | --- |
| `paused` | 일시 중지 |
| `capacity` | 동시 실행 수 |
| `tokens` | 레이트 |
| `perKey` | 키별 동시 실행 수 |
| `perKeyTokens` | 키별 레이트 |

<h3 id="get-apibindings">GET /api/bindings</h3>

작업을 투입할 binding 이름 목록을 가져옵니다.
한 번도 실행되지 않은 binding을 포함해 `performers`에 등록한 모든 binding 이름이 대상입니다.

```json
{ "bindings": ["CHARGE", "MAIL"] }
```

<h2 id="実行量の設定">실행량 설정</h2>

<h3 id="post-apibindingsbindingpolicy">POST /api/bindings/:binding/policy</h3>

실행량 설정을 실행 중에 변경합니다.
변경은 `bindings`의 설정보다 우선합니다.

```json
{ "paused": true, "concurrency": 5 }
```

| 항목 | 설명 |
| --- | --- |
| `paused` | 투입 일시 중지. 중지 중에도 실행 중인 작업의 감시는 계속됨 |
| `concurrency` | 동시 실행 수. 0 이상의 정수 |
| `perKeyConcurrency` | 키별 동시 실행 수. 0 이상의 정수 |
| `rate` | `{ tokens, intervalMs }`. `null`이면 레이트 제한 해제 |
| `perKeyRate` | `{ tokens, intervalMs }`. 키별 레이트. `null`이면 제한 해제 |
| `agingIntervalMs` | 에이징 간격. `null`이면 에이징 없음 |
| `reaperGraceMs` | 무응답으로 판정하기까지의 유예 시간. 0 이상의 정수 |

지정한 항목만 변경되고 생략한 항목은 유지됩니다.
성공하면 변경 후 설정과 적용된 shard 수가 응답에 포함됩니다.
다음은 `paused`와 `concurrency`를 변경한 경우의 예시입니다.

```json
{
  "binding": "MAIL",
  "shards": 1,
  "policy": {
    "paused": true,
    "concurrency": 5,
    "perKeyConcurrency": 1,
    "rate": null,
    "perKeyRate": null,
    "agingIntervalMs": 60000,
    "reaperGraceMs": 30000
  }
}
```

변경은 대상 binding에 속한 모든 shard에 적용됩니다.
shard를 분할한 경우 네트워크 단절이나 일시적인 장애로 일부 shard에 변경을 적용하지 못할 수 있습니다.
이 경우 HTTP 상태 코드 500으로 응답하며 본문에 실패한 shard 번호가 포함됩니다.

```json
{ "error": "the change reached 3 of 4 shards, send the same request again", "binding": "MAIL", "shards": 4, "failed": [2] }
```

같은 요청을 다시 보내면 나머지 shard에 변경이 적용됩니다.
몇 번을 보내도 설정 결과는 같습니다.
변경한 뒤에는 `bindings`의 설정이 적용되지 않습니다.

<h3 id="post-apibindingsbindingpolicyreset">POST /api/bindings/:binding/policy/reset</h3>

실행 중에 한 변경을 버리고 `bindings`의 설정으로 되돌립니다.
다음 투입부터 `bindings`의 설정이 다시 적용됩니다.

```json
{ "ok": true }
```

일부 shard에 적용하지 못한 경우 `policy` 변경과 마찬가지로 500으로 응답하며 `failed`가 본문에 포함됩니다.

<h2 id="定期実行">정기 실행</h2>

`schedules`를 정의하지 않은 구성에서는 이 섹션의 엔드포인트가 501로 응답합니다.
자세한 내용은 [정기 실행](/ko/guide/schedule)을 참조하세요.

<h3 id="get-apischedules">GET /api/schedules</h3>

정기 실행 목록을 가져옵니다.
작업 목록과 달리 상태가 실시간으로 반영됩니다.

```json
{
  "schedules": [
    {
      "name": "nightly",
      "kind": "flow",
      "target": "REPORT",
      "every_ms": null,
      "cron": "0 3 * * *",
      "time_zone": "Asia/Tokyo",
      "overlap": "skip",
      "paused": false,
      "next_occurrence_at": 1767722400000,
      "last_occurrence_at": 1767636000000,
      "last_fired_at": 1767636001200,
      "last_job_id": null,
      "last_run_id": "REPORT:nightly-1767636000000",
      "last_skipped_at": null,
      "skipped_count": 0,
      "last_error": null
    }
  ]
}
```

| 항목 | 의미 |
| --- | --- |
| `name` | 스케줄 이름. `schedules`의 키 |
| `kind` | `job` 또는 `flow` |
| `target` | binding 이름 또는 Flow 이름 |
| `every_ms` | 고정 간격. `cron`을 지정한 경우 `null` |
| `cron` | cron 식. `everyMs`를 지정한 경우 `null` |
| `time_zone` | cron과 표시에 사용하는 IANA 시간대. 고정 간격에서는 `UTC` |
| `overlap` | `skip` 또는 `overlap` |
| `paused` | 일시 중지 중인지 여부 |
| `next_occurrence_at` | 다음 실행 예정 시각 |
| `last_occurrence_at` | 이전 실행의 예정 시각. 한 번도 실행하지 않았으면 `null` |
| `last_fired_at` | 이전 실행의 실제 시각. `last_occurrence_at`과의 차이가 실행 지연 |
| `last_job_id` | 이전 실행에서 투입한 작업의 ID. `kind`가 `flow`이면 `null` |
| `last_run_id` | 이전 실행에서 시작한 Run의 ID. `kind`가 `job`이면 `null` |
| `last_skipped_at` | 마지막으로 실행하지 않은 회차의 시각. 해당하는 회차가 없으면 `null` |
| `skipped_count` | 이전 실행이 끝나지 않아 실행하지 않은 횟수 |
| `last_error` | 이전 실행이 실패한 이유. 성공한 경우 `null` |

이름이 `_at`으로 끝나는 항목은 epoch 밀리초입니다.

<h3 id="post-apischedulesnamepause">POST /api/schedules/:name/pause</h3>

일시 중지 중에는 정기 실행이 이루어지지 않습니다.
중지 전에 투입된 작업은 영향을 받지 않습니다.

```json
{ "ok": true }
```

<h3 id="post-apischedulesnameresume">POST /api/schedules/:name/resume</h3>

일시 중지 중인 스케줄을 재개합니다.
중지 중에 지나간 회차는 실행되지 않습니다.
재개 후 다음 실행은 재개한 시점 이후의 첫 번째 예정 시각입니다.

```json
{ "ok": true }
```

<h3 id="post-apischedulesnametrigger">POST /api/schedules/:name/trigger</h3>

스케줄을 즉시 1회 실행합니다.

```json
{ "id": "REPORT:nightly-1767650000000-1-manual", "kind": "flow" }
```

`id`는 투입한 작업의 ID 또는 시작한 Run의 ID입니다.
`kind`는 `id`가 작업과 Run 중 무엇을 가리키는지 나타냅니다.
일시 중지 중에도 실행되며 `overlap` 판정은 이루어지지 않습니다.
다음 정기 실행 시각은 변경되지 않습니다.
실행에 실패한 경우 500과 오류 상세 정보로 응답합니다.
목록의 `last_error` 값은 이 오류 상세 정보와 같습니다.

<h2 id="run">Run</h2>

<h3 id="get-apiflows">GET /api/flows</h3>

등록된 Flow 이름을 가져옵니다.
실행 여부와 관계없이 `flows`에 등록한 모든 Flow 이름이 대상입니다.

```json
{ "flows": ["GREETINGS", "PIPELINE"] }
```

<h3 id="get-apiruns">GET /api/runs</h3>

Run 목록을 가져옵니다.
각 Run에 대해 node의 진행 상황이 포함됩니다.

<h4 id="クエリパラメータ-2">쿼리 파라미터</h4>

| 이름 | 기본값 | 설명 |
| --- | --- | --- |
| `state` | 없음 | `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED` 중 하나 |
| `flow` | 없음 | Flow 이름으로 필터링 |
| `limit` | 20 | 최대 100 |
| `offset` | 0 | 페이징 |

```json
{
  "runs": [
    {
      "id": "GREETINGS:cl9x0a1b2c3d",
      "flow": "GREETINGS",
      "state": "RUNNING",
      "node_total": 6,
      "node_done": 4,
      "node_failed": 0,
      "created_at": 1767225600000,
      "updated_at": 1767225603000
    }
  ],
  "total": 1
}
```

<h3 id="get-apirunsid">GET /api/runs/:id</h3>

Run 1건과 해당 Run에 포함된 node를 가져옵니다.
node에는 사전에 정의된 정적 node와 실행 중에 동적으로 추가된 node가 모두 포함됩니다.

```json
{
  "run": {
    "id": "GREETINGS:cl9x0a1b2c3d",
    "flow": "GREETINGS",
    "state": "RUNNING",
    "input": "{\"prefix\":\"hello\"}",
    "node_total": 6,
    "node_done": 4,
    "node_failed": 0,
    "created_at": 1767225600000,
    "updated_at": 1767225603000,
    "parent_run_id": null,
    "parent_node_id": null,
    "retryable": false
  },
  "nodes": [
    {
      "id": "greet",
      "binding": "GREET",
      "state": "RUNNING",
      "container": true,
      "parent": null,
      "origin": "static",
      "after": ["list"],
      "job_id": null,
      "child_run_id": null,
      "result": null,
      "error": null,
      "position": 1,
      "created_at": 1767225600000,
      "updated_at": 1767225603000
    }
  ]
}
```

`container`가 `true`인 node는 fan-out node입니다.
fan-out node는 작업을 갖지 않으므로 `job_id`는 `null`입니다.
`result`는 자식 node의 집계값을 포함합니다.
`parent`를 가진 node는 실행 중에 추가된 node입니다.
`origin`은 `fanOut` 또는 `spawn`입니다.
subflow로 시작된 Run에서는 `parent_run_id`와 `parent_node_id`에 부모 Run과 node의 ID가 포함됩니다.
subflow node에서는 `child_run_id`에 시작한 자식 Run의 runId가 포함됩니다.

<h3 id="post-apiruns">POST /api/runs</h3>

Run을 시작합니다.
요청 본문은 Flow 이름과 입력을 포함한 JSON입니다.

```json
{ "flow": "GREETINGS", "input": { "prefix": "hello" }, "id": "order-1234" }
```

| 항목 | 필수 | 설명 |
| --- | --- | --- |
| `flow` | 필수 | 등록된 Flow 이름. 등록되지 않은 경우 400 |
| `input` | 필수 | 임의의 JSON. 타입 검사는 적용되지 않음 |
| `id` | 선택 | runId의 로컬 부분. 같은 ID로 두 번째 시작하면 기존 runId로 응답 |
| `deadlineMs` | 선택 | Run 전체의 기한(밀리초). 양의 정수. 기한을 넘기면 중단되고 `FAILED`로 전환. Flow 정의의 기한보다 우선 |

성공하면 201로 응답하며 본문은 시작한 Run의 runId를 포함합니다.
다음 예시의 runId는 `flow`와 `id`로 만들어진 `GREETINGS:order-1234`입니다.

```json
{ "id": "GREETINGS:order-1234" }
```

<h3 id="post-apirunsidretry">POST /api/runs/:id/retry</h3>

실패한 Run을 재개합니다.
완료된 node의 결과는 그대로 이어받습니다.
`FAILED`, `STALLED`, `SKIPPED`, `CANCELLED` 상태의 node는 미실행 상태로 보고 다시 실행합니다.
fan-out으로 만들어진 자식 node 중 다시 실행되는 것은 Run의 기한이 지나 중단된 자식 node뿐입니다.
실행했다가 실패한 자식 node는 다시 실행하지 않습니다.

재개 대상은 `FAILED` 상태의 Run뿐입니다.
그 밖의 상태인 Run에는 409로 응답합니다.
존재하지 않는 Run과 보존 기간이 지난 Run에는 410으로 응답합니다.

<h3 id="post-apirunsidcancel">POST /api/runs/:id/cancel</h3>

Run을 취소합니다.
아직 실행되지 않은 node는 시작되지 않으며, 실행 중인 node에는 [취소 요청](/ko/guide/execution#実行中の取り消し)이 전송됩니다.
실행 중인 작업은 강제로 중지되지 않습니다.
Run은 performer가 요청을 확인하고 종료한 경우, 또는 요청 후 `reaperGraceMs`(기본 30초)가 지나도 결과가 보고되지 않은 경우에 `CANCELLED`로 전환됩니다.
취소 대상은 `RUNNING` 상태의 Run뿐입니다.

<h2 id="get-apiopenapijson">GET /api/openapi.json</h2>

모든 엔드포인트의 파라미터와 응답 형식을 기술한 OpenAPI 3.1 정의를 가져옵니다.
