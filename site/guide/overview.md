---
title: 概要
description: Cloudflare Workers向けのジョブマネジメントシステムTsumugiが解決する課題, 利用者が記述するコード, 前提条件
publishedAt: 2026-07-22
updatedAt: 2026-10-25
---

# 概要

Tsumugiは、Cloudflare Workers向けに設計されたジョブマネジメントシステムです。
利用者は、ジョブの処理をperformerとして定義し、enqueueでジョブを投入します。
ジョブの配送, 実行, 状態の記録はTsumugiが担います。
管理用のダッシュボードとREST APIも提供します。

## 何を解決するの

Cloudflare Queuesをジョブキューとして直接使うといくつかの問題が生じます。

### ジョブの状態を管理しづらく、成功したジョブが残らない

Queuesは、投入したメッセージの状態を問い合わせるAPIを提供していません。
成功したメッセージも保持されず、過去の実行を後から確認する手段が用意されていません。

TsumugiのダッシュボードとREST APIは、実行中のジョブと終了したジョブの両方について、一覧表示, 検索, 集計を提供します。
`TSUMUGI_METRICS`のbindingを設定すると、失敗率と実行時間がメトリクスとして記録されます。

### 排他制御と重複排除を実装しづらい

Queuesは、メッセージ間の依存関係や関連性を管理しません。
そのため、同一顧客に対する同時実行の防止や、重複投入の排除は、利用者が個別に実装する必要があります。

Tsumugiでは、`concurrencyKey`を指定したジョブは、同じキーのものから1件ずつ順に実行されます。
`uniqueKey`を指定すると、一定期間内に同じキーで投入されたジョブは重複とみなされ、新しいジョブを作らずに既存のジョブIDを戻り値とします。

### ジョブの種類が増えるほど分岐が増える

Queuesでは、1つのキューに対してconsumerを1つしか設定できません。
そのため、ジョブの種類が増えると、キューの数を増やすか、consumer内での分岐処理が複雑になっていきます。

Tsumugiは、performerのexport名をbinding名としてジョブの種類を区別するため、consumerに分岐を書く必要がありません。
binding名とpayloadの型の関係は、[binding名](/guide/performer#binding名)で説明しています。

### まれにメッセージが失われる

Queuesは、処理されずに失われたメッセージを検出する手段を提供していません。

Tsumugiは、実行を開始したジョブから結果が報告されない場合、そのジョブを無応答と判定します。
`at-least-once`セマンティクスの場合、無応答のジョブは再投入されます。
`at-most-once`セマンティクスの場合、無応答のジョブは`STALLED`状態に遷移し、手動でリトライされるまで実行されません。

## 利用者が記述するコード

記述するのはジョブの処理の定義と投入のたった2箇所だけです。

```ts
import { defineTsumugi } from 'tsumugi';
import { Performer } from 'tsumugi/performer';

// 1. ジョブの処理をperformerとして定義してexportする
export class SendMail extends Performer<{ to: string }, void, {}, Env> {
  async perform(payload: { to: string }): Promise<void> {
    await this.env.MAILER.send(payload.to);
  }
}

const tsumugi = defineTsumugi({ performers: { SendMail } });

// 2. 投入する。binding名はexportした名前
const id = await tsumugi.enqueue(env, { binding: 'SendMail', payload: { to: 'a@example.com' } });
```

キューの構成, consumerの分岐, 状態の記録を書く必要はありません。
各機能は、[ジョブの投入](/guide/enqueue), [実行の制御](/guide/execution), [定期実行](/guide/schedule), [ダッシュボードと認証](/guide/dashboard)で説明しています。

## 前提条件

Workers Paidプランと、2025-11-17以降の`compatibility_date`が必要です。
必要なリソースと設定は`npx tsumugi init`で作成します。
手順は[Getting Started](/guide/getting-started)を参照してください。

## 着想

Cloudflareのサービスで完結するジョブキューに、ダッシュボードを同梱するという構成は、[Kiribi](https://kiribi.pages.dev/)から着想を得ました。
導入の手順を最小限にし、利用者に内部構成を意識させない方針も、Kiribiと共通しています。

Tsumugiは、実行量の制限, ジョブごとの実行保証, リトライの制御, Flowによる多段の実行, 定期実行を備えています。
これらの機能により、利用者が用意するリソースと設定は、Kiribiに比べて多くなります。
