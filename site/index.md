---
layout: home

hero:
  name: Tsumugi
  tagline: A job management system designed for the Cloudflare stack.
  actions:
    - theme: brand
      text: Getting Started
      link: /guide/getting-started
    - theme: alt
      text: 概要
      link: /guide/overview
    - theme: alt
      text: GitHub
      link: https://github.com/chan-mai/Tsumugi
    - theme: alt
      text: npm
      link: https://www.npmjs.com/package/tsumugi

features:
  - title: 書くのは処理とenqueueだけ
    details: performerに処理を書き、必要な場所からenqueueを呼び出します。ジョブの配送、consumerでの実行、状態の記録はTsumugiが引き受けます
  - title: 非同期処理をメソッド呼び出しのように
    details: enqueue(env, { binding, payload })でジョブを投入し、その場でジョブIDを受け取れます。Queuesの構成やconsumerのルーティングを意識する必要はありません
  - title: ジョブ基盤に欲しいものを最初から
    details: リトライ、バックオフ、予約実行、定期実行、優先度、同時実行数・レート制限、重複排除、管理画面まで標準で備えています
  - title: 実行したジョブをあとから追える
    details: 成功・失敗を含むすべてのジョブ状態をD1に保持します。一覧、検索、集計は通常のSQLで扱え、失敗率や実行時間はAnalytics Engineにも記録できます
  - title: 実行保証はジョブに合わせて
    details: 既定はat-least-once。二重実行を避けたい処理にはat-most-onceを指定でき、ジョブの性質に応じて実行保証を選べます
  - title: 処理を別のWorkerへ分離できる
    details: performerはService Binding越しのWorkerにも配置できます。投入だけを行うWorkerにDurable Objectの実装を抱えさせる必要はありません
  - title: 複雑な処理も
    details: ノードと依存関係を宣言するだけで、前段の戻り値を次のpayloadへつなげられます。実行時に件数が決まる並列処理にも対応します
---
