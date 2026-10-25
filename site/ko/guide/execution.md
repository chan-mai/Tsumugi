---
title: 실행 제어
description: 잡의 상태와 전이, 재시도와 백오프, 실행 보장, 타임아웃, 실행량 제한, 보존 기간, 실패와 종료 알림에 대해 설명합니다
publishedAt: 2026-07-22
updatedAt: 2026-10-25
---

<h1 id="実行の制御">실행 제어</h1>

<h2 id="状態">상태</h2>

| 상태 | 의미 |
| --- | --- |
| `SCHEDULED` | 최초 실행과 재시도 실행을 기다리는 상태 |
| `QUEUED` | 실행 대상이 되었으며 performer 시작 전인 상태 |
| `RUNNING` | performer 실행 중인 상태 |
| `COMPLETED` | 성공. 종료 상태 중 하나이며 다른 상태로 전이하지 않음 |
| `FAILED` | 시도 횟수 상한까지 실패한 상태. 수동 재시도로 `SCHEDULED`로 전이 |
| `CANCELLED` | 취소된 상태. 종료 상태 중 하나이며 다른 상태로 전이하지 않음 |
| `STALLED` | 결과가 보고되지 않은 채 정지한 상태. 수동 재시도에 한해 `SCHEDULED`로 전이 |

`attempts`는 종료된 시도의 횟수입니다.
`SCHEDULED` 상태의 잡은 `attempts`가 0이면 최초 실행을 기다리는 것이고, 1 이상이면 재시도를 기다리는 것입니다.
`FAILED`와 `STALLED` 상태의 잡은 대시보드 또는 REST API에서 수동으로 재시도하세요.

<h3 id="遷移">전이</h3>

`SCHEDULED` 상태의 잡을 취소하면 즉시 `CANCELLED`로 전이합니다.
`QUEUED`와 `RUNNING` 상태의 잡은 기한이 지났거나 [실행 중 취소](#実行中の取り消し)가 확정되면 `CANCELLED`로 전이합니다.

<h2 id="リトライ">재시도</h2>

재시도 횟수의 상한은 `maxAttempts`로, 간격은 `backoff`로 설정합니다.
`maxAttempts`에는 1 이상의 정수를 지정하세요.
`backoff`는 고정 간격인 `fixed`와 지수 백오프인 `exponential` 중 하나의 형식으로 지정합니다.

::callout{type="info"}
wrangler.jsonc의 `max_retries`는 Queues 설정입니다. Tsumugi의 재시도에는 영향을 주지 않습니다.
::

<h3 id="バックオフ">백오프</h3>

기본값은 다음과 같은 지수 백오프입니다.

```ts
{ kind: 'exponential', baseMs: 1_000, factor: 2, maxMs: 3_600_000, jitter: true }
```

고정 간격으로 하려면 `kind`에 `fixed`를 지정하세요.

```ts
await tsumugi.enqueue(env, {
  binding: 'MAIL',
  payload,
  backoff: { kind: 'fixed', delayMs: 30_000, jitter: true },
});
```

`jitter: true`를 지정하면 동시에 실패한 다수 잡의 재시도 시각이 분산됩니다.
performer에서 재시도 여부와 다음 재시도 시각을 지정하는 방법은 [재시도 지정](/ko/guide/performer#再試行の指定)을 참조하세요.

<h2 id="実行保証">실행 보장</h2>

`guarantee`는 `at-least-once`(기본값)와 `at-most-once` 중 하나입니다.
결과가 보고되지 않은 잡의 동작은 선택한 값에 따라 달라집니다.

| 보장 | 결과가 보고되지 않은 경우의 동작 |
| --- | --- |
| `at-least-once`(기본값) | `SCHEDULED`로 재투입 |
| `at-most-once` | 재투입 없이 `STALLED`로 전이. 재실행은 수동 재시도로만 가능 |

```ts
await tsumugi.enqueue(env, {
  binding: 'CHARGE',
  payload,
  guarantee: 'at-most-once',
});
```

`at-most-once` 잡은 중복 실행되지 않습니다.
대신 실행을 시작하기까지의 시간이 `at-least-once`보다 길어집니다.

<h2 id="タイムアウトと無応答">타임아웃과 무응답</h2>

`timeoutMs`를 넘긴 시도는 실패로 처리됩니다.
시도의 에러에는 `TsumugiTimeoutError`(`job timed out (<jobId>, <timeoutMs>ms)`)가 기록됩니다.
타임아웃 후에도 performer의 실행은 중단되지 않습니다.
처리를 중단하는 방법은 [타임아웃에 의한 중단](/ko/guide/performer#タイムアウトによる中断)을 참조하세요.

`QUEUED` 또는 `RUNNING` 상태의 잡은 실행 시작(또는 마지막 `heartbeat`)으로부터 `timeoutMs`와 `reaperGraceMs`(기본값 30초)가 지나도 시도 결과가 기록되지 않으면 무응답으로 판정됩니다.
`at-most-once` 잡은 시도 횟수와 관계없이 `STALLED`로 전이합니다.
`at-least-once` 잡은 시도 횟수가 상한에 도달하지 않았다면 재투입되고, 도달했다면 `FAILED`로 전이합니다.

<h2 id="実行中の取り消し">실행 중 취소</h2>

`QUEUED`와 `RUNNING` 상태의 잡을 취소하면 performer에 대한 취소 요청이 기록됩니다.
취소는 대시보드 또는 [`POST /api/jobs/:id/cancel`](/ko/reference/rest-api#post-apijobsidcancel)로 실행합니다.
이 엔드포인트의 응답에는 `requested: true`가 포함됩니다.

performer는 `ctx.heartbeat()`의 반환값 `cancelRequested`로 요청을 확인합니다.
처리를 중단하려면 예외를 throw하여 종료하세요.
요청 후에 실패한 시도는 재시도되지 않으며, 잡은 `CANCELLED`로 전이합니다.

```ts
const { cancelRequested } = await ctx.heartbeat(progress);
if (cancelRequested) throw new Error('cancelled');
```

요청보다 먼저 성공이 보고된 경우 잡은 `COMPLETED` 상태로 유지되며 결과도 저장됩니다.
요청으로부터 `reaperGraceMs`(기본값 30초)가 지나도 결과가 보고되지 않으면 잡이 `CANCELLED`로 전이합니다.
performer의 실행은 중단되지 않으므로, 요청을 확인하지 않는 performer는 실행을 계속합니다.
`CANCELLED`로 전이한 이후의 보고는 폐기됩니다.

재시도를 기다리는 잡은 재투입되지 않고 `CANCELLED`로 전이합니다.
실행 전의 `at-most-once` 잡도 실행되지 않고 `CANCELLED`로 전이합니다.
취소를 요청한 잡에 `reschedule`을 요청하면 REST API는 409로 응답합니다.
`heartbeat`를 호출하지 않는 performer는 요청을 확인하지 않습니다.

<h2 id="実行量の制限">실행량 제한</h2>

binding별로 4개의 설정으로 실행량을 제한합니다.

| 설정 | 기본값 | 내용 |
| --- | --- | --- |
| `concurrency` | `100` | 동시에 실행하는 잡 수의 상한 |
| `rate` | `null` | 일정 시간당 실행하는 잡 수의 상한. `null`은 제한 없음 |
| `perKeyConcurrency` | `1` | `concurrencyKey`별 동시 실행 수의 상한 |
| `perKeyRate` | `null` | `concurrencyKey`별 일정 시간당 실행 수의 상한. `null`은 제한 없음 |

```ts
const tsumugi = defineTsumugi({
  performers,
  bindings: {
    MAIL: {
      policy: {
        concurrency: 20,
        rate: { tokens: 100, intervalMs: 60_000 },
        perKeyConcurrency: 1,
        perKeyRate: { tokens: 10, intervalMs: 60_000 },
      },
    },
  },
});
```

`perKeyRate`는 모든 키에 같은 값으로 적용됩니다.
키마다 다른 값을 설정하는 항목은 제공되지 않습니다.
`concurrencyKey`가 null인 잡에는 `perKeyConcurrency`와 `perKeyRate`가 적용되지 않습니다.

<h3 id="実行されない原因の確認">실행되지 않는 원인 확인</h3>

투입한 잡이 실행되지 않는 경우 [`GET /api/diagnostics`](/ko/reference/rest-api#get-apidiagnostics)의 응답에서 실행을 제한하고 있는 설정을 확인하세요.
응답은 일시 정지, 동시 실행 수, 레이트 중 무엇이 원인인지 알려 줍니다.

<h3 id="実行時の変更">실행 중 변경</h3>

대시보드의 `bindings` 탭에서는 동시 실행 수 변경과 투입 일시 정지를 조작합니다.
변경에는 배포가 필요하지 않으며 binding의 모든 shard에 적용됩니다.
이 조작은 [`POST /api/bindings/:binding/policy`](/ko/reference/rest-api#post-apibindingsbindingpolicy)를 호출하는 것과 같습니다.

```bash
curl -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"paused": true}' https://example.com/api/bindings/MAIL/policy
```

재개 후에는 일시 정지 전부터 대기하던 우선순위가 낮은 잡이, 나중에 투입된 우선순위가 높은 잡보다 먼저 실행될 수 있습니다.

![bindings 탭](/dashboard-bindings.jpg)

코드에서 변경하려면 `tsumugi.shardFor`로 가져온 stub의 `configure`를 호출하세요.
`configure`는 `policy`로 실행량 설정을, `sweepAfterMs`와 `failedRetentionMs`로 보존 기간을 변경합니다.

```ts
await tsumugi.shardFor(env, 'MAIL').configure({ policy: { concurrency: 5 } });
```

실행 중에 변경한 설정은 `bindings`의 설정보다 우선합니다.
그 이후에는 `bindings`의 설정이 적용되지 않습니다.
`bindings`의 설정으로 되돌리려면 [`POST /api/bindings/:binding/policy/reset`](/ko/reference/rest-api#post-apibindingsbindingpolicyreset)를 호출하세요.
또는 `configure`로 원래 내용을 다시 지정합니다.

<h2 id="エージング">에이징</h2>

우선순위가 높은 잡이 계속 투입되면 우선순위가 낮은 잡이 언제까지나 실행되지 않습니다.
이를 방지하기 위해 대기 시간에 따라 실효 우선순위가 올라갑니다.
이 동작을 에이징이라고 하며 기본으로 적용됩니다.
우선순위가 올라가는 간격은 `agingIntervalMs`이며 기본값은 60초입니다.
`null`을 지정하면 에이징이 적용되지 않고 우선순위 순서대로 잡이 실행됩니다.

<h2 id="shard">shard</h2>

shard는 binding의 잡을 분할하여 관리하는 단위입니다.
기본 shard 수는 1입니다.

```ts
bindings: {
  MAIL: { shards: 4 },
}
```

shard 수를 2 이상으로 하면 `partitionKey`가 필수가 되며, 생략하면 예외가 발생합니다.
`concurrencyKey`와 `uniqueKey`로 제어하는 범위는 shard 수에 따라 달라집니다.
shard 수가 1이면 binding 내의 모든 잡이 대상입니다.
2 이상이면 `partitionKey`로 선택되는 같은 shard의 잡으로 한정됩니다.

`concurrencyKey` 또는 `uniqueKey`를 사용하는 경우 `partitionKey`에도 같은 키를 지정하세요.
다른 값을 설정해도 에러는 발생하지 않지만, 같은 키를 가진 잡이 서로 다른 shard에 할당될 수 있습니다.
그 결과 동시 실행이나 중복 생성이 발생할 수 있습니다.

<h2 id="保持期間">보존 기간</h2>

종료된 잡은 일정 기간이 지나면 삭제됩니다.

| 대상 | 설정 | 기본값 |
| --- | --- | --- |
| `COMPLETED` / `CANCELLED` | `sweepAfterMs` | 5분 |
| `FAILED` / `STALLED` | `failedRetentionMs` | 7일 |

삭제된 잡은 재시도할 수 없습니다.
두 설정 모두 `bindings`에서 binding별로 지정합니다.

```ts
const tsumugi = defineTsumugi({
  performers,
  bindings: {
    MAIL: { sweepAfterMs: 60 * 60 * 1000, failedRetentionMs: 14 * 24 * 60 * 60 * 1000 },
  },
});
```

대시보드와 REST API의 목록에 표시하는 기간은 보존 기간과 별도로 `retention`에서 설정합니다.
cron 트리거를 설정하면 기간이 지난 종료된 잡과 Run이 목록에서 삭제됩니다.
자세한 내용은 [SweepOptions](/ko/reference/config#sweepoptions)를 참조하세요.

기본적으로 두 기간은 일치합니다.
따라서 목록에 표시된 `FAILED`와 `STALLED` 잡은 재시도 대상입니다.
한쪽 기간만 변경한 경우에는 목록에 표시된 잡이라도 재시도 요청에 대해 REST API가 410으로 응답할 수 있습니다.

<h2 id="失敗の通知">실패 알림</h2>

`onFailure`에 알림을 받을 binding 이름을 지정하면 `FAILED`와 `STALLED` 상태의 잡이 지정한 performer에 알림으로 전달됩니다.
`FAILED`는 시도 횟수의 상한까지 실패한 잡입니다.
`STALLED`는 결과가 보고되지 않은 채 정지한 잡입니다.

```ts
const tsumugi = defineTsumugi({
  performers,
  onFailure: 'NotifyFailure',
});
```

알림을 받는 performer는 `FailureNotice`를 인수로 받습니다.

```ts
import { Performer } from 'tsumugi/performer';
import type { FailureNotice } from 'tsumugi';

export class NotifyFailure extends Performer<FailureNotice, void, {}, Env> {
  async perform(notice: FailureNotice): Promise<void> {
    const res = await fetch(this.env.SLACK_WEBHOOK, {
      method: 'POST',
      body: JSON.stringify({ text: `${notice.binding} が失敗しました: ${notice.error}` }),
    });
    if (!res.ok) throw new Error(`notification failed: ${res.status}`);
  }
}
```

<h3 id="failurenotice">FailureNotice</h3>

| 이름 | 내용 |
| --- | --- |
| `jobId` | 실패한 잡의 ID |
| `binding` | 실패한 잡의 binding |
| `state` | `FAILED` 또는 `STALLED` |
| `attempts` | 실행한 횟수 |
| `maxAttempts` | 시도 횟수의 상한 |
| `error` | 마지막 시도의 에러. 기록이 없으면 `null` |
| `runId` | 투입한 Run. 단독으로 투입한 잡은 `null` |
| `nodeId` | 투입한 node. 단독으로 투입한 잡은 `null` |
| `failedAt` | 실패한 시각. epoch 밀리초 |

모든 binding의 잡이 알림 대상입니다.
알림은 1건의 잡으로 실행됩니다.
알림 잡이 실패하면 그 잡은 목록에 표시됩니다.
알림 잡도 다른 잡과 마찬가지로 재시도 대상입니다.
알림을 받는 binding 자신의 잡 실패는 알림이 전달되지 않습니다.
`onFailure`를 지정하기 전에 실패한 잡은 대상이 아닙니다.

<h2 id="終了の通知">종료 알림</h2>

`onSettled`를 지정하면 실패뿐 아니라 종료된 잡이 지정한 performer에 알림으로 전달됩니다.
알림을 보낼 상태는 `states`에 지정하며 `COMPLETED`, `FAILED`, `CANCELLED`, `STALLED` 중에서 선택합니다.
`states`는 필수입니다. 빈 배열이나 올바르지 않은 상태를 지정하면 `defineTsumugi`에서 예외가 발생합니다.

```ts
const tsumugi = defineTsumugi({
  performers,
  onSettled: {
    binding: 'NotifySettled',
    states: ['COMPLETED', 'FAILED', 'CANCELLED', 'STALLED'],
  },
});
```

`COMPLETED`를 포함하면 완료된 잡과 같은 수의 알림 잡이 투입됩니다.
잡의 건수를 확인한 후에 지정하세요.
알림을 받는 performer는 `SettledNotice`를 인수로 받습니다.

<h3 id="settlednotice">SettledNotice</h3>

| 이름 | 내용 |
| --- | --- |
| `jobId` | 종료된 잡의 ID |
| `binding` | 종료된 잡의 binding |
| `state` | 종료 시의 상태 |
| `attempts` | 실행한 횟수 |
| `maxAttempts` | 시도 횟수의 상한 |
| `error` | 마지막 시도의 에러. 실패 이외의 종료와 기록이 없는 경우는 `null` |
| `result` | `perform`의 반환값. `COMPLETED` 이외와 저장 상한을 초과한 경우는 `null` |
| `runId` | 투입한 Run. 단독으로 투입한 잡은 `null` |
| `nodeId` | 투입한 node. 단독으로 투입한 잡은 `null` |
| `settledAt` | 종료된 시각. epoch 밀리초 |

알림을 받는 binding 자신의 잡과 `onFailure`로 알림을 받는 binding의 잡은 알림이 전달되지 않습니다.
`onFailure`와 동시에 지정한 경우, `states`에 포함한 `FAILED`와 `STALLED`는 두 알림 대상 모두에 전달됩니다.
`onSettled`를 지정하기 전에 종료된 잡은 대상이 아닙니다.

<h2 id="投入時の既定値">투입 시 기본값</h2>

`onEnqueue`를 지정하면 잡을 투입할 때마다 `onEnqueue`가 호출되고, 그 반환값이 실행 옵션의 기본값으로 사용됩니다.
호출하는 쪽에서 지정한 값이 항상 우선하며, 기본값은 옵션이 명시되지 않은 경우에만 적용됩니다.

```ts
const tsumugi = defineTsumugi({
  performers,
  onEnqueue: (input) => (input.binding === 'SlowJob' ? { timeoutMs: 300_000 } : undefined),
});
```

기본값으로 지정할 수 있는 실행 옵션은 `traceparent`, `priority`, `maxAttempts`, `backoff`, `timeoutMs`, `guarantee`, `delayMs`, `runAt`, `expiresAt`, `expiresInMs`, `concurrencyKey`입니다.
`binding`, `payload`, `uniqueKey`, `uniqueForMs`, `partitionKey`는 대상이 아닙니다.

`onFailure`와 `onSettled`의 알림 잡에는 `onEnqueue`가 적용되지 않습니다.
다른 Worker에서 투입하는 잡에도 적용하려면 [`createClient`](/ko/guide/client#投入時の既定値)에 같은 함수를 전달하세요.
