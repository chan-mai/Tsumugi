---
title: CLI
description: tsumugi 패키지에 포함된 CLI 명령인 tsumugi init과 tsumugi add-performer의 옵션과 동작에 대해
publishedAt: 2026-07-22
updatedAt: 2026-10-25
---

<h1 id="cli">CLI</h1>

`tsumugi` 패키지에는 설정용 CLI가 포함되어 있습니다.
별도로 설치할 필요는 없습니다.
패키지를 추가한 프로젝트에서 `npx tsumugi`를 실행합니다.
인수 없이 실행하면 대화 모드로 시작합니다.
파이프나 CI처럼 TTY가 아닌 환경에서는 대화 모드로 전환되지 않고, 사용 방법을 출력한 뒤 종료합니다.

```bash
npx tsumugi
```

<h2 id="tsumugi-init">tsumugi init</h2>

프로젝트에 Tsumugi를 설정합니다.

```bash
npx tsumugi init [--name <name>] [--format jsonc|toml]
```

`init`은 `wrangler queues create <name>`과 `wrangler d1 create <name>`으로 리소스를 생성합니다.
wrangler 설정 파일이 없으면 새로 생성하고, `wrangler d1 create`가 출력한 `database_id`를 기록합니다.
다음으로 `src/index.ts`, `src/performers/`, `.dev.vars`를 생성합니다.
마지막으로 `wrangler d1 migrations apply`(`--local`과 `--remote`)와 `wrangler types`를 실행합니다.

<h3 id="オプション">옵션</h3>

| 옵션 | 내용 |
| --- | --- |
| `--name <name>` | Worker의 이름. 생략하면 기존 설정 파일의 `name`, `package.json`의 `name`, 디렉터리 이름 순으로 사용 |
| `--format <jsonc\|toml>` | 생성할 설정 파일의 형식. 기본값은 `jsonc` |

<h3 id="既存ファイルの扱い">기존 파일의 처리</h3>

`init`은 기존 파일을 변경하지 않습니다.
wrangler 설정 파일(`wrangler.json`, `wrangler.jsonc`, `wrangler.toml`)이 이미 존재하는 경우에는 추가할 내용을 해당 파일의 형식으로 출력합니다.
`src/index.ts` 등의 템플릿 중 이미 존재하는 파일은 다시 생성하지 않습니다.

<h2 id="tsumugi-add-performer">tsumugi add-performer</h2>

performer를 추가합니다.

```bash
npx tsumugi add-performer <NAME>
```

`add-performer`는 `src/performers/<name>.ts`에 performer 클래스를 생성합니다.
`src/performers/index.ts`에는 export 줄을 한 줄 추가합니다.
이름은 kebab-case, camelCase, PascalCase, SNAKE_CASE 중 어느 형식이든 받아들입니다.
클래스 이름은 PascalCase로, 파일 이름은 kebab-case로 변환합니다.
예를 들어 `send-mail`은 클래스 `SendMail`과 파일 `send-mail.ts`로 생성됩니다.

<h3 id="service-bindingの設定">Service Binding 설정</h3>

다른 Worker에서 이 performer를 호출하는 경우에는 호출하는 쪽의 설정 파일에 `services` 값을 추가하세요.
`add-performer`는 추가해야 할 값을 출력합니다.
같은 Worker 안에서 performer를 실행하는 경우에는 추가할 필요가 없습니다.
