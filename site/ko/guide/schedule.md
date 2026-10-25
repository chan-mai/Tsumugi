---
title: 정기 실행
description: 잡과 Flow를 일정 간격 또는 cron 식으로 지정한 시각에 실행하는 방법과, 일시 정지, 재개, 수동 실행 조작에 대해
publishedAt: 2026-07-22
updatedAt: 2026-10-25
---

<h1 id="定期実行">정기 실행</h1>

`schedules`에 정의한 잡과 Flow를 Tsumugi는 일정 간격으로, 또는 cron 식으로 지정한 시각에 실행합니다.

<h2 id="定義">정의</h2>

```ts
const tsumugi = defineTsumugi({
  performers,
  flows,
  schedules: {
    'poll-inbox': { binding: 'PollInbox', payload: {}, everyMs: 5 * 60 * 1000 },
    nightly: {
      flow: 'REPORT',
      input: ({ scheduledAt }) => ({ until: scheduledAt }),
      cron: '0 9 * * *',
      timeZone: 'Asia/Tokyo',
    },
  },
  auth: /* ... */,
});
```

스케줄 이름은 키로 지정합니다.
사용할 수 있는 문자는 영문자, 숫자, 하이픈, 언더스코어이며 길이는 64자 이내입니다.
`binding`을 지정하면 잡을 enqueue하고, `flow`를 지정하면 Run을 시작합니다.
둘 중 하나만 지정하세요.
`payload`와 `input`의 타입은 단독 잡 enqueue나 Run 시작과 마찬가지로 `performers`와 `flows`에서 도출됩니다.
shard 수가 2 이상인 binding을 대상으로 하는 경우 `partitionKey`도 필수입니다.

`payload`와 `input`에는 값 대신 함수도 지정할 수 있습니다.
함수를 지정하면 실행할 때마다 호출되며 반환값이 사용됩니다.
인수 `scheduledAt`은 해당 회차의 실행 예정 시각입니다.

```ts
{ binding: 'Sync', payload: ({ scheduledAt }) => ({ since: scheduledAt - 60_000 }), everyMs: 60_000 }
```

잡을 enqueue하는 스케줄 정의에는 `maxAttempts`, `backoff`, `timeoutMs`, `priority`, `concurrencyKey` 등의 옵션을 선택적으로 지정할 수 있습니다.
Run을 시작하는 스케줄 정의에는 `deadlineMs`를 선택적으로 지정할 수 있습니다.
스케줄 정의에서는 `uniqueKey`, `delayMs`, `runAt`을 사용할 수 없습니다.

정의에 오류가 있으면 `defineTsumugi`를 호출할 때 예외가 발생합니다.
이름 규칙에 어긋나는 경우, `binding`과 `flow`를 모두 지정했거나 둘 다 지정하지 않은 경우가 해당합니다.
대상 binding의 shard 수가 2 이상인데 `partitionKey`를 생략한 경우나 사용할 수 없는 옵션을 지정한 경우에도 마찬가지로 예외가 발생합니다.

<h2 id="実行間隔">실행 간격</h2>

`everyMs`와 `cron` 중 하나만 지정하세요.
둘 다 지정하거나 둘 다 지정하지 않으면 정의 오류가 발생합니다.

<h3 id="everyms">everyMs</h3>

`everyMs`에는 1000 이상의 정수(밀리초)를 지정하세요.
1000 미만의 값을 지정하면 정의 오류가 발생합니다.
첫 번째 실행은 스케줄을 등록하고 1 간격이 지난 뒤에 이루어집니다.
이후에는 첫 번째 예정 시각에 1 간격씩 더한 시각에 실행됩니다.

<h3 id="cron">cron</h3>

`cron`은 분, 시, 일, 월, 요일의 5개 필드로 지정합니다.
정밀도는 분 단위이며 초와 연도 필드는 포함하지 않습니다.

```text
0 3 * * *     매일 3:00
*/15 * * * *  15분마다
0 0 1 * *     매월 1일 0:00
0 9 * * 1-5   월요일부터 금요일 9:00
```

사용할 수 있는 표기는 숫자, `*`, `,`, `-`, `/`입니다.
`JAN`이나 `MON` 같은 이름은 사용할 수 없습니다.
2월 31일처럼 실행 기회가 없는 식을 지정하면 정의 오류가 발생합니다.
일과 요일을 모두 지정한 경우에는 둘 중 하나가 일치하면 실행됩니다.
`*/2`처럼 `*`로 시작하는 일이나 요일은 지정하지 않은 것으로 취급됩니다.
이 경우 일과 요일이 모두 일치하는 날에 실행됩니다.

<h3 id="timezone">timeZone</h3>

`timeZone`에 IANA 시간대를 지정하면 `cron`을 해석할 때 해당 시간대가 적용됩니다.
생략하면 `UTC`가 사용됩니다.
`+09:00` 같은 고정 오프셋을 지정하면 정의 오류가 발생합니다.

```ts
{ binding: 'OpenShop', payload: {}, cron: '0 9 * * 1-5', timeZone: 'Asia/Tokyo' }
```

`timeZone`은 `cron`과 함께 사용하세요.
`everyMs`와 동시에 지정하면 정의 오류가 발생합니다.
`everyMs`는 시각의 차이로 계산되므로 시간대의 영향을 받지 않습니다.

서머타임 전환으로 존재하지 않게 된 현지 시각의 회차는 실행되지 않습니다.
같은 현지 시각이 두 번 있는 경우에는 첫 번째에 한해 실행됩니다.

<h2 id="前回の実行が終了していない場合">이전 실행이 끝나지 않은 경우</h2>

`overlap`은 이전 실행이 완료되기 전에 다음 예정 시각이 된 경우의 동작을 지정합니다.
값은 `'skip'` 또는 `'overlap'` 중 하나이며 기본값은 `'skip'`입니다.
이 외의 값을 설정하면 정의 오류가 발생합니다.

| 값 | 동작 |
| --- | --- |
| `'skip'` | 해당 회차의 실행을 생략. 기본값 |
| `'overlap'` | 이전 실행의 상태와 관계없이 실행 |

이전 잡이 `SCHEDULED`, `QUEUED`, `RUNNING` 중 하나의 상태이면 해당 실행은 끝나지 않은 것으로 간주됩니다.
Run의 경우에는 이전 Run이 `RUNNING`이면 끝나지 않은 것입니다.
실행되지 않은 횟수는 대시보드 목록에 표시됩니다.

```ts
{ binding: 'Crawl', payload: {}, everyMs: 60_000, overlap: 'overlap' }
```

<h2 id="実行の遅れ">실행 지연</h2>

부하나 배포의 영향으로 실행이 예정 시각보다 늦어질 수 있습니다.
지연이 여러 간격에 걸치면 가장 오래된 예정 회차가 1회 실행되고 나머지 회차는 실행되지 않습니다.
다음 예정 시각은 현재 시각 이후의 첫 번째 예정 시각입니다.
지연이 발생한 뒤에도 예정 시각은 첫 번째 예정 시각에 간격을 더한 시각 그대로입니다.

<h2 id="重複実行の防止">중복 실행 방지</h2>

같은 예정 시각의 회차가 중복해서 실행되는 일은 없습니다.
두 번째 실행에서는 새 잡이나 Run이 생성되지 않고 기존 잡 또는 Run의 ID가 재사용됩니다.

스케줄 정의에서 `uniqueKey`를 사용할 수 없는 것은 이 구조 때문입니다.
지정하면 중복을 판정하는 기간 내의 모든 회차가 첫 번째 건과 같은 잡으로 취급됩니다.

<h2 id="失敗">실패</h2>

`payload` 또는 `input` 함수에서 예외가 발생한 회차는 실행되지 않습니다.
잡 enqueue나 Run 시작에 실패한 회차도 마찬가지로 실행되지 않습니다.
실패 이유는 기록되며 해당 회차는 재시도되지 않습니다.
다른 스케줄의 실행에는 영향을 주지 않습니다.

<h2 id="一覧">목록</h2>

대시보드의 `schedules` 탭에 정의한 스케줄 목록이 표시됩니다.
같은 목록은 `GET /api/schedules`로 가져올 수 있습니다.
다음 예정 시각, 이전 실행, 실행되지 않은 횟수, 실패 이유, 일시 정지 상태가 포함됩니다.

![스케줄 목록](/dashboard-schedules.jpg)

시각은 스케줄에 설정된 IANA 시간대 및 해당 시점의 GMT 오프셋과 함께 표시됩니다.

<h2 id="一時停止と再開">일시 정지와 재개</h2>

대시보드의 `schedules` 탭, 또는 `POST /api/schedules/:name/pause`와 `POST /api/schedules/:name/resume`으로 스케줄별 정기 실행의 일시 정지와 재개를 제어합니다.
일시 정지 중에는 해당 스케줄의 실행이 억제됩니다.
정지 중에 예정 시각이 지나간 회차는 재개 후에 실행되지 않습니다.
재개 후 첫 번째 실행은 재개 시점 이후에 오는 첫 번째 예정 시각입니다.
정지 전에 enqueue된 잡의 실행에는 영향이 없습니다.

스케줄의 일시 정지는 binding의 `paused`와는 별개의 설정입니다.
binding을 일시 정지하면 해당 binding으로 enqueue되는 모든 잡의 실행이 정지됩니다.
스케줄의 일시 정지가 멈추는 것은 해당 스케줄의 실행입니다.

<h2 id="手動実行">수동 실행</h2>

대시보드의 `schedules` 탭에 있는 "지금 실행"과 `POST /api/schedules/:name/trigger`로 스케줄을 원하는 시점에 1회 실행합니다.
일시 정지 중인 스케줄도 대상입니다.
`overlap`은 판정하지 않으며 다음 정기 실행 시각도 바뀌지 않습니다.
`payload`와 `input` 함수가 받는 `scheduledAt`은 수동 실행한 시각입니다.

<h2 id="開始条件">시작 조건</h2>

정기 실행은 배포 후 Worker가 HTTP 요청, 큐 메시지, cron 트리거 중 하나를 처음 수신한 시점에 시작합니다.
그 후에는 외부에서 호출하지 않아도 실행됩니다.
외부 접근이 없는 구성에서는 목록 보관 기간을 위해 설정한 cron 트리거가 그 역할을 합니다.
정의를 변경하고 배포한 경우 변경 사항은 다음 회차부터 반영됩니다.

<h2 id="設定">설정</h2>

`schedules`를 지정하는 경우 wrangler 설정에 다음 2곳을 추가하세요.
지정하지 않는 경우에는 이 설정이 필요 없습니다.

```jsonc
{
  "durable_objects": {
    "bindings": [
      { "name": "JOB_SHARD", "class_name": "TsumugiJobShard" },
      { "name": "SCHEDULER", "class_name": "TsumugiScheduler" },
    ],
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["TsumugiJobShard"] },
    { "tag": "v3", "new_sqlite_classes": ["TsumugiScheduler"] },
  ],
}
```

`TsumugiScheduler`는 `defineTsumugi`의 반환값인 `schedulerClass`를 상속하여 export하세요.
클래스 이름은 wrangler 설정과 일치시켜야 합니다.

```ts
export { TsumugiJobShard } from 'tsumugi';
export class TsumugiScheduler extends tsumugi.schedulerClass {}
```
