---
title: 개요
description: Cloudflare Workers용 잡 관리 시스템 Tsumugi가 해결하는 문제, 사용자가 작성하는 코드, 전제 조건
publishedAt: 2026-07-22
updatedAt: 2026-10-25
---

<h1 id="概要">개요</h1>

Tsumugi는 Cloudflare Workers용으로 설계된 잡 관리 시스템입니다.
사용자는 잡의 처리를 performer로 정의하고, enqueue로 잡을 투입합니다.
잡의 전달, 실행, 상태 기록은 Tsumugi가 담당합니다.
관리용 대시보드와 REST API도 제공합니다.

<h2 id="何を解決するの">무엇을 해결하나요</h2>

Cloudflare Queues를 잡 큐로 직접 사용하면 몇 가지 문제가 발생합니다.

<h3 id="ジョブの状態を管理しづらく成功したジョブが残らない">잡의 상태를 관리하기 어렵고, 성공한 잡이 남지 않는다</h3>

Queues는 투입한 메시지의 상태를 조회하는 API를 제공하지 않습니다.
성공한 메시지도 보관되지 않으며, 과거의 실행을 나중에 확인할 수단이 마련되어 있지 않습니다.

Tsumugi의 대시보드와 REST API는 실행 중인 잡과 종료된 잡 모두에 대해 목록 표시, 검색, 집계를 제공합니다.
`TSUMUGI_METRICS` binding을 설정하면 실패율과 실행 시간이 메트릭으로 기록됩니다.

<h3 id="排他制御と重複排除を実装しづらい">배타 제어와 중복 제거를 구현하기 어렵다</h3>

Queues는 메시지 간의 의존 관계나 연관성을 관리하지 않습니다.
따라서 동일 고객에 대한 동시 실행 방지나 중복 투입 제거는 사용자가 개별적으로 구현해야 합니다.

Tsumugi에서는 `concurrencyKey`를 지정한 잡은 같은 키를 가진 잡끼리 한 건씩 순서대로 실행됩니다.
`uniqueKey`를 지정하면 일정 기간 내에 같은 키로 투입된 잡은 중복으로 간주되며, 새 잡을 만들지 않고 기존 잡 ID를 반환값으로 돌려줍니다.

<h3 id="ジョブの種類が増えるほど分岐が増える">잡의 종류가 늘어날수록 분기가 늘어난다</h3>

Queues에서는 하나의 큐에 consumer를 하나만 설정할 수 있습니다.
따라서 잡의 종류가 늘어나면 큐의 수를 늘리거나 consumer 내부의 분기 처리가 복잡해집니다.

Tsumugi는 performer의 export 이름을 binding 이름으로 사용해 잡의 종류를 구분하므로, consumer에 분기를 작성할 필요가 없습니다.
binding 이름과 payload 타입의 관계는 [binding名](/ko/guide/performer#binding名)에서 설명합니다.

<h3 id="まれにメッセージが失われる">드물게 메시지가 유실된다</h3>

Queues는 처리되지 않고 유실된 메시지를 감지할 수단을 제공하지 않습니다.

Tsumugi는 실행을 시작한 잡에서 결과가 보고되지 않으면 해당 잡을 무응답으로 판정합니다.
`at-least-once` 시맨틱스의 경우, 무응답 잡은 다시 투입됩니다.
`at-most-once` 시맨틱스의 경우, 무응답 잡은 `STALLED` 상태로 전이하며 수동으로 재시도하기 전까지 실행되지 않습니다.

<h2 id="利用者が記述するコード">사용자가 작성하는 코드</h2>

작성할 부분은 잡 처리의 정의와 투입, 단 두 곳뿐입니다.

```ts
import { defineTsumugi } from 'tsumugi';
import { Performer } from 'tsumugi/performer';

// 1. 잡의 처리를 performer로 정의하고 export한다
export class SendMail extends Performer<{ to: string }, void, {}, Env> {
  async perform(payload: { to: string }): Promise<void> {
    await this.env.MAILER.send(payload.to);
  }
}

const tsumugi = defineTsumugi({ performers: { SendMail } });

// 2. 투입한다. binding 이름은 export한 이름이다
const id = await tsumugi.enqueue(env, { binding: 'SendMail', payload: { to: 'a@example.com' } });
```

큐의 구성, consumer의 분기, 상태 기록을 작성할 필요는 없습니다.
각 기능은 [ジョブの投入](/ko/guide/enqueue), [実行の制御](/ko/guide/execution), [定期実行](/ko/guide/schedule), [ダッシュボードと認証](/ko/guide/dashboard)에서 설명합니다.

<h2 id="前提条件">전제 조건</h2>

Workers Paid 플랜과 2025-11-17 이후의 `compatibility_date`가 필요합니다.
필요한 리소스와 설정은 `npx tsumugi init`으로 생성합니다.
절차는 [Getting Started](/ko/guide/getting-started)를 참조하십시오.

<h2 id="着想">착안</h2>

Cloudflare 서비스만으로 완결되는 잡 큐에 대시보드를 함께 제공하는 구성은 [Kiribi](https://kiribi.pages.dev/)에서 착안했습니다.
도입 절차를 최소한으로 줄이고 사용자가 내부 구성을 의식하지 않게 한다는 방침도 Kiribi와 같습니다.

Tsumugi는 실행량 제한, 잡별 실행 보장, 재시도 제어, Flow를 통한 다단계 실행, 정기 실행을 갖추고 있습니다.
이러한 기능 때문에 사용자가 준비해야 하는 리소스와 설정은 Kiribi보다 많아집니다.
