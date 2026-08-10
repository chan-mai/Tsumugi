---
layout: home

hero:
  name: Tsumugi
  tagline: Cloudflareスタック向けに設計されたジョブ管理システム
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

features:
  - title: 記述するのは2箇所
    details: performerクラスを定義し, enqueueを呼び出します。投入先の決定, consumerでの実行, 一覧への反映はTsumugiが処理します
  - title: 非同期実行をメソッド呼び出しとして記述
    details: enqueue(env, { binding, payload })がジョブIDを返します。キューの構成もconsumerの分岐もあなたが意識する必要はありません
  - title: 運用に必要な機能を標準で備える
    details: リトライ, バックオフ, 予約実行, 定期実行, 優先度, 同時実行数とレートの制限, 重複排除, 管理画面を提供します。後から追加する必要がありません
  - title: 成功したジョブも保持する
    details: すべての状態がD1に残るため, 一覧と検索と集計を通常のSQLで記述します。失敗率と実行時間はAnalytics Engineに記録することも可能です
  - title: 実行保証をジョブごとに選択
    details: 既定はat-least-onceです。二重実行を避けるジョブのみat-most-onceを指定します
  - title: performerの配置を選択
    details: service binding越しに別のWorkerへ配置できます。投入のみを行うWorkerはDurable Objectの実装をバンドルしません
  - title: 多段の処理をFlowとして定義
    details: Flowにノードと依存関係を宣言すると, 前段の戻り値から後段のpayloadを組み立てます。実行時に件数が決まる並列処理にも対応します
---
