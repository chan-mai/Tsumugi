---
title: 대시보드와 인증
description: REST API와 대시보드의 인증 설정, 그리고 대시보드에서 job과 Run을 조회, 검색, 일괄 조작하는 방법
publishedAt: 2026-07-22
updatedAt: 2026-10-25
---

<h1 id="ダッシュボードと認証">대시보드와 인증</h1>

::callout{type="warning"}
`auth`를 지정하지 않으면 REST API와 대시보드로 들어오는 모든 요청에 404로 응답합니다.
::

<h2 id="bearerauth">bearerAuth</h2>

`bearerAuth`는 단일 토큰을 사용하여 요청을 인증합니다.

```ts
import { bearerAuth, defineTsumugi } from 'tsumugi';

const tsumugi = defineTsumugi({
  performers,
  auth: bearerAuth((env: Env) => env.TSUMUGI_TOKEN, { cookie: 'tsumugi_token' }),
});
```

토큰은 위 예시처럼 함수를 통해 Secret에서 가져오세요.
문자열로 직접 작성하면 리포지토리와 번들 양쪽에 토큰이 포함되어 보안 위험이 생깁니다.

<h3 id="cookie">cookie</h3>

`cookie` 옵션을 지정하면 `Authorization` 헤더에 더해, 지정한 이름의 cookie에 포함된 토큰도 검증합니다.
브라우저는 최초 HTML을 가져올 때 `Authorization` 헤더를 붙이지 않습니다.
대시보드를 열려면 이 설정이 반드시 필요합니다.

cookie를 통한 인증은 CSRF의 대상이 될 수 있습니다.
cookie를 발급하는 쪽에서는 `SameSite=Strict`를 명시적으로 지정하세요.

<h2 id="cloudflare-access">Cloudflare Access</h2>

`cloudflareAccess`를 지정하면 Cloudflare Access가 발급한 JWT를 검증합니다.
`auth`는 `bearerAuth`, `cloudflareAccess`, `unsafeNoAuth`의 반환값 외에 임의의 Hono 미들웨어도 받을 수 있습니다.

```ts
import { cloudflareAccess, defineTsumugi } from 'tsumugi';

const tsumugi = defineTsumugi({
  performers,
  auth: cloudflareAccess({ teamDomain: 'example', aud: 'audience tag' }),
});
```

| 이름 | 내용 |
| --- | --- |
| `teamDomain` | `<team>.cloudflareaccess.com`의 team 부분 |
| `aud` | Access 애플리케이션의 audience tag |
| `cacheTtlMs` | JWKS를 다시 가져오는 간격. 기본값은 1시간 |

<h2 id="認証しない構成">인증하지 않는 구성</h2>

::callout{type="danger"}
`unsafeNoAuth`를 지정하면 REST API와 대시보드가 인증을 요구하지 않습니다.
Worker에 접근할 수 있는 모든 사용자가 payload를 포함한 job의 내용을 열람하고, job을 enqueue, 취소, 재실행할 수 있습니다.
공개 환경에서는 사용하지 마세요.
::

`unsafeNoAuth`는 Tsumugi보다 앞단에서 인증하는 경우에만 사용합니다.
Cloudflare Access를 라우트 전체에 적용한 구성이나 `wrangler dev`에서의 동작 확인이 이에 해당합니다.
인증하지 않을 때는 `auth`를 생략하지 말고 `unsafeNoAuth`를 명시하세요.
`unsafeNoAuth`를 지정하는 동안에는 로그에 경고가 출력됩니다.

```ts
import { defineTsumugi, unsafeNoAuth } from 'tsumugi';

const tsumugi = defineTsumugi({
  performers,
  auth: unsafeNoAuth(),
});
```

<h2 id="ダッシュボードの有効化">대시보드 활성화</h2>

`tsumugi/ui`의 `ui()`를 `defineTsumugi`의 `ui`에 전달하면, `/api` 이외 경로로 들어오는 GET 요청에 대시보드의 HTML로 응답합니다.
`ui`를 지정하지 않으면 대시보드는 번들에 포함되지 않습니다.
API가 401로 응답하면 대시보드는 토큰 입력란을 표시합니다.

```ts
import { ui } from 'tsumugi/ui';

const tsumugi = defineTsumugi({
  performers,
  auth: bearerAuth((env: Env) => env.TSUMUGI_TOKEN, { cookie: 'tsumugi_token' }),
  ui: ui({ tokenCookie: 'tsumugi_token' }),
});
```

| 이름 | 내용 |
| --- | --- |
| `tokenCookie` | 토큰을 저장하는 cookie의 이름. `bearerAuth`의 `cookie`와 같은 값 |

<h2 id="ジョブの一覧">job 목록</h2>

job 목록에서는 상태, binding, 생성 일시의 범위로 필터링하고, 페이징과 열별 정렬을 조작할 수 있습니다.
job ID, `uniqueKey`, `concurrencyKey`로 검색하는 기능도 갖추고 있습니다.
job 상세 페이지에는 시도 이력, 진행 상황, 로그, 트레이스 정보가 표시됩니다.
수동 재시도와 취소, 선택한 job의 일괄 재시도와 일괄 취소, job enqueue도 job 목록 페이지에서 조작합니다.

![job 목록 페이지](/dashboard-jobs.jpg)

<h3 id="検索">검색</h3>

검색란에 입력한 값은 완전 일치로 검색됩니다.
job ID 형식과 일치하는 값을 입력하면 해당 job의 상세 정보가 표시됩니다.

<h3 id="一括操作">일괄 조작</h3>

행의 왼쪽 끝에 있는 체크박스로 job을 선택합니다.
머리글 행의 체크박스는 표시 중인 모든 행을 선택합니다.
1건 이상을 선택하면 선택한 job을 한꺼번에 재시도하거나 취소하는 메뉴가 표시됩니다.

<h3 id="表示の設定">표시 설정</h3>

표시 설정은 브라우저에 저장되며 다음 접속부터도 적용됩니다.
갱신 간격은 Off, 1s, 3s, 10s, 30s, 1m 중에서 선택하며, 기본값은 3초입니다.
열 표시는 ID, Started at, Updated at, Attempts, Processing time을 전환할 수 있습니다.
Binding과 Status는 항상 표시됩니다.
한 페이지의 건수는 10, 20, 30, 50 중에서 선택합니다.
언어는 사이드바 하단에서 일본어와 English 중 전환합니다.
처음에는 브라우저의 언어 설정을 따릅니다.

<h3 id="時刻の表示">시각 표시</h3>

정기 실행의 시각은 각 스케줄의 시간대로 표시됩니다.
그 외의 시각은 브라우저의 IANA 시간대로 표시됩니다.
모든 시각에 IANA 시간대와 GMT 오프셋이 함께 표시됩니다.
생성 일시의 범위는 브라우저 로컬 날짜의 연월일로 지정합니다.

<h2 id="ジョブの詳細">job 상세</h2>

<h3 id="試行履歴">시도 이력</h3>

시도별 시작 시각, 종료 시각, 오류가 job 상세에 표시됩니다.
저장되는 건수와 오류 본문 길이의 상한은 [실패와 재시도](/ko/guide/performer#失敗とリトライ)를 참조하세요.
시도 이력은 job 상세의 응답에만 포함되며, 목록의 응답에는 포함되지 않습니다.
첫 번째 시도에서 성공한 경우는 이력에 기록되지 않습니다.

![시도 이력 표시](/dashboard-attempts.jpg)

<h3 id="ログとトレース情報">로그와 트레이스 정보</h3>

`ctx.log()`로 저장한 메시지는 수신 순서대로 job 상세에 표시됩니다.
각 로그에는 시도 횟수, 기록 시각, 본문이 포함됩니다.
실행 중인 job의 로그도 표시되지만, 표시되기까지 시간이 걸릴 수 있습니다.
저장되는 건수, 본문 길이, 저장 간격의 상한은 [로그](/ko/guide/performer#ログ)를 참조하세요.
로그의 보존 기간은 job의 보존 기간과 같습니다.

enqueue 시 `traceparent`를 지정한 job에서는 그 값이 job 상세에 표시됩니다.
performer에서의 사용 방법은 [트레이스 정보](/ko/guide/performer#トレース情報)를 참조하세요.

<h3 id="リトライ可否の表示">재시도 가능 여부 표시</h3>

목록의 각 행에는 `retryable`이 포함됩니다.
`retryable`은 job이 `FAILED` 또는 `STALLED` 상태이면서 보존 기간 내인지를 나타내는 지표입니다.
재시도의 성공은 보장되지 않습니다.
보존 기간이 지난 job에 대한 재시도 요청에는 REST API가 410으로 응답합니다.

<h2 id="runs">Runs</h2>

`flows`를 설정하면 사이드바에 Runs 항목이 표시됩니다.
`flows`가 비어 있으면 표시되지 않습니다.

Run 목록은 Flow, 상태, node의 진행 상황을 표시합니다.
Flow 또는 상태를 지정하면 일치하는 Run만 목록에 표시됩니다.
행을 선택하면 상세 패널이 열립니다.
상세 패널은 그래프와 워터폴의 두 가지 표시를 제공합니다.

![Run의 워터폴](/dashboard-run.jpg)

워터폴은 각 node의 실행 시간을 시간축 위에 나열한 표시입니다.
그래프는 node의 의존 관계, 각 node의 상태, fan-out node의 자식 node 진행 상황을 표시합니다.
자식 node는 24개까지 표시되며, 초과분은 상태별 건수로 나타냅니다.
워터폴의 행이나 그래프의 node를 선택하면 해당 job의 상세 정보가 열립니다.

subflow로 시작된 Run의 상세에는 부모 Run의 ID가 링크로 표시됩니다.
이 링크를 선택하면 부모 Run의 상세 정보가 열립니다.
그래프 위의 subflow node에는 자식 Run의 상세 정보를 여는 버튼이 있습니다.
워터폴의 subflow 행을 선택해도 자식 Run의 상세 정보가 열립니다.

Run의 시작, 재개, 취소는 Runs 페이지에서 조작합니다.
재개 대상은 `FAILED` 상태의 Run이고, 취소 대상은 `RUNNING` 상태의 Run입니다.
