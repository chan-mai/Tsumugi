---
title: Getting Started
description: Tsumugi 설치부터 performer를 정의한 Worker의 동작 확인까지
publishedAt: 2026-07-22
updatedAt: 2026-10-25
---

<h1 id="getting-started">Getting Started</h1>

<h2 id="前提条件">사전 요구 사항</h2>

Workers Paid 플랜이 활성화된 Cloudflare 계정이 필요합니다.
`compatibility_date`는 2025-11-17 이후로 설정하세요.

<h2 id="インストール">설치</h2>

```bash
pnpm create cloudflare@latest my-jobs --type=hello-world
cd my-jobs
pnpm add tsumugi
```

<h2 id="セットアップ">설정</h2>

```bash
npx tsumugi init
```

새 프로젝트에서 `init`을 실행하면 필요한 Cloudflare 리소스를 만들고 `wrangler.jsonc`, `src/index.ts`, `src/performers/`, `.dev.vars`를 생성합니다.
마지막으로 데이터베이스 마이그레이션을 적용하고 종료합니다.
중간에 실패하면 경고와 함께 다시 실행할 명령을 출력합니다.

wrangler 설정 파일이 이미 있으면 `init`은 설정 파일을 수정하지 않고 추가해야 할 내용을 출력합니다.
이 경우 마이그레이션도 적용되지 않습니다.
설정 파일을 편집한 후 출력된 절차에 따라 마이그레이션을 적용하세요.
옵션과 생성되는 파일은 [CLI](/ko/reference/cli)에서 설명합니다.

`TSUMUGI_METRICS` binding은 선택 사항입니다.
설정하지 않으면 메트릭이 기록되지 않지만, 다른 동작은 달라지지 않습니다.
Flow와 정기 실행을 사용하는 경우에는 추가 binding을 설정하세요.
설정 내용은 [wrangler의 binding](/ko/reference/config#wranglerのbinding), [Flow 설정](/ko/guide/flow#設定), [정기 실행 설정](/ko/guide/schedule#設定)에 기재되어 있습니다.

::callout{type="warning"}
Tsumugi를 업데이트한 후에는 마이그레이션을 다시 적용하세요.
새 버전에서 마이그레이션이 추가되었을 수 있습니다.
적용되지 않은 마이그레이션이 남아 있으면 REST API는 503으로 응답하며, 응답 본문에 적용되지 않은 파일 이름을 포함합니다.
::

<h2 id="performer">performer</h2>

작업 처리는 performer로 정의합니다.
`init`이 생성하는 `src/performers/hello.ts`가 가장 작은 예제입니다.
`perform`의 처리와 payload의 타입을 용도에 맞게 수정하세요.

```ts
// src/performers/hello.ts
import { Performer } from 'tsumugi/performer';

export class Hello extends Performer<{ name: string }, void, {}, Env> {
  async perform(payload: { name: string }): Promise<void> {
    console.log(`hello, ${payload.name}`);
  }
}
```

performer를 추가할 때는 `add-performer`를 실행하세요.

```bash
npx tsumugi add-performer send-mail
```

performer 파일이 생성되고 `src/performers/index.ts`에 export 줄이 한 줄 추가됩니다.

```ts
// src/performers/index.ts
export { Hello } from './hello.js';
export { SendMail } from './send-mail.js';
```

<h2 id="worker">Worker</h2>

`init`은 다음 내용의 `src/index.ts`를 생성합니다.
performer는 Worker의 엔트리포인트에서 export하며, 그 이름이 binding 이름으로 사용됩니다.
binding 이름의 규칙은 [binding 이름](/ko/guide/performer#binding名)에서 설명합니다.

```ts
import { bearerAuth, defineTsumugi } from 'tsumugi';
import { ui } from 'tsumugi/ui';
import * as performers from './performers/index.js';

export * from './performers/index.js';

const tsumugi = defineTsumugi({
  performers,
  // secret에서 가져옴, 직접 작성하면 리포지토리와 번들에 남음
  auth: bearerAuth((env: Env) => env.TSUMUGI_TOKEN, { cookie: 'tsumugi_token' }),
  ui: ui({ tokenCookie: 'tsumugi_token' }),
});

// Durable Object 클래스를 다시 export해야 함
export { TsumugiJobShard } from 'tsumugi';

export default {
  ...tsumugi,
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/enqueue') {
      const id = await tsumugi.enqueue(env, { binding: 'Hello', payload: { name: 'world' } });
      return Response.json({ id });
    }
    // 나머지는 대시보드와 REST API로 전달
    return tsumugi.fetch!(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
```

`defineTsumugi`의 반환값에는 `fetch`, `queue`, `scheduled` 핸들러 외에 작업을 투입하는 함수와 Flow를 시작하는 함수가 포함됩니다.
반환값 목록은 [설정](/ko/reference/config#definetsumugi)에, 투입 방법별 차이는 [작업 투입](/ko/guide/enqueue#投入方法)에 기재되어 있습니다.

<h2 id="トークンの設定">토큰 설정</h2>

`auth`를 지정하지 않으면 `tsumugi.fetch`는 모든 요청에 404로 응답합니다.
위 예제에서는 `bearerAuth`를 사용합니다. 로컬 환경에서는 `.dev.vars`에 정의된 `TSUMUGI_TOKEN`을 참조합니다.
프로덕션 환경에서는 아래 명령을 실행하여 Secret을 등록하세요.

```bash
pnpm wrangler secret put TSUMUGI_TOKEN
```

<h2 id="動作確認">동작 확인</h2>

```bash
pnpm wrangler dev
```

`/enqueue`에 접속하면 Hello 작업이 투입되고, 작업 ID를 포함한 `{ "id": "..." }` 응답이 반환됩니다.
투입한 작업은 대시보드(`/`)의 목록에 표시됩니다.
토큰 입력을 요청받으면 `.dev.vars`의 `TSUMUGI_TOKEN` 값을 입력하세요.
`init`이 생성한 직후의 값은 `dev-token`입니다.

<h2 id="次に参照するページ">다음으로 볼 페이지</h2>

- [Performer](/ko/guide/performer): 작업 처리를 정의합니다.
- [작업 투입](/ko/guide/enqueue): 예약 실행, 우선순위, 중복 제거
- [실행 제어](/ko/guide/execution): 작업 상태 관리, 재시도 설정, 실행량 제한, 실행 보장에 대해 설명합니다.
