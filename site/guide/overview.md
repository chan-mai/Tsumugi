# 概要

TsumugiはCloudflareスタック向けに設計されたジョブ管理システムです。

## 何を解決するか

Cloudflare Queuesをそのままジョブキューとして使う場合、いくつか困ることがあります。

### ステータスが管理しづらく、成功したジョブは揮発する

投入したメッセージの現在の状態を問い合わせるAPIがなく、成功したメッセージは残らないため、過去の実行を後から参照することが困難です。

この問題を解決するため、Tsumugiはすべてのジョブの状態をD1の読み取りモデルへ反映しています。

実行中のジョブと終了したジョブが同じテーブルにあるため、一覧も検索も集計も通常のSQLとして記述可能です。
失敗率や実行時間のような時系列のデータはAnalytics Engineへ記録するため、D1側の削除設定とは独立して保持されます。

### 排他制御や重複抑制がやりにくい

メッセージから他のメッセージを参照できないため、「同じ顧客のジョブを同時に実行しない」も「同じ内容を二重に投入しない」のような処理も自分で実装する必要があります。

Tsumugiはbinding単位で実行中のジョブの状態を管理しています。
`concurrencyKey`を明示することでキー単位で順次実行され、`uniqueKey`を明示することで同じキー単位での排他が保証されます。

### ジョブの種類が増えるほど分岐が増える

consumerはキューに対して1つしか指定できないため、ジョブの種類が増えるほど、キューを増やすかconsumer側の分岐が増えるかのどちらかになってしまいます。

Tsumugiではキューを1本のまま使い、種類をbinding名で区別しています。
binding名はperformerのexport名がそのまま使われ、payloadの型も同じ場所から決定されるため、分岐のための冗長な実装は不要です。

### 希にキューが消失する

Queuesに投入したまま処理されなかった・消失してしまった場合に、それを検知する手段がありません。

Tsumugiは、実行を開始したまま結果が報告されないジョブを検知します。
事前定義に基づき、`at-least-once`のジョブは再投入、`at-most-once`のジョブは`STALLED`にして手動での判断を待つようにもできます。

## Tsumugiがやること

上記課題は、Queuesの上にDurable ObjectやD1、Analytics Engineを組み合わせることで解決可能ですが、その複雑な組み合わせ自体を実装する必要があります。

どのDurable Objectへ投入するか、consumerで何を実行するか、状態をいつD1へ書き込むか、リトライを誰が決めるか。

Tsumugiはこれらを内部でいい感じに処理します。

あなたが書くのは2箇所だけです。

```ts
import { enqueue } from 'tsumugi';
import { Performer } from 'tsumugi/performer';

// 1. ジョブの中身をperformerとして定義してexportする
export class SendMail extends Performer<{ to: string }, void, {}, Env> {
  async perform(payload: { to: string }): Promise<void> {
    await this.env.MAILER.send(payload.to);
  }
}

// 2. 投入する。binding名はexportした名前
const id = await enqueue(env, { binding: 'SendMail', payload: { to: 'a@example.com' } });
```

キューの構成もconsumerの分岐も一覧への反映も、意識する必要はありません。
リトライ、バックオフ、予約実行、優先度、実行量の制限、重複排除、管理画面は最初から利用できます。

## 構成要素

![Tsumugiの構成](/architecture.png)

| リソース         | 役割                               |
| ---------------- | ---------------------------------- |
| Durable Object   | ジョブの状態管理と実行順序の決定   |
| Queues           | performerの実行                    |
| D1               | 一覧と検索と集計に使用するテーブル |
| Analytics Engine | 時系列メトリクス                   |

## 必要なもの

- Workers Paidプラン
- `compatibility_date` 2025-11-17以降
- D1データベースへのマイグレーション適用が必要です
- Analytics Engine(時系列メトリクスを記録する場合のみ)

## 着想

Cloudflareスタックだけでジョブキューを構成し、ダッシュボードを同梱するという形は[Kiribi](https://kiribi.pages.dev/)からインスパイアを受けています。
少ない手順で導入でき、手軽にブラックボックスとして利用できるという考え方は、Tsumugiでも引き継いでいます。

Tsumugiはそこに、Durable Objectによる状態の一元管理を加えました。
実行量の制限、ジョブごとの実行保証、リトライの制御、Flowによる多段の実行、定期実行は、いずれもこの一元管理を前提としています。

用意するリソースと設定は少しだけ多いですが、より安定したジョブキューを構成でき、より多くの、大規模なユースケースに対応できます。
