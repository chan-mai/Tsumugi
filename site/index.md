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
  - title: 状態を1箇所で管理する
    details: binding単位のDurable Objectがスケジューラを兼ね, 稼働中ジョブの状態をSQLiteで保持する. シングルスレッドなので同時実行数を正確に数えられ, レート制限もキー単位の直列化も実装できる
  - title: 実行保証はジョブごとに選ぶ
    details: 既定はat-least-once. 二重実行が致命的なジョブだけat-most-onceにすると, 実行前にDurable Objectへclaimを取得する
  - title: リトライの制御はDurable Objectが持つ
    details: Queuesのretryには乗らず常に即ack. 試行回数もバックオフもwrangler.jsoncの設定に縛られない
  - title: キーを型で必須化する
    details: performerがconcurrencyKeyやuniqueKeyを必要と宣言でき, 渡し忘れはコンパイルエラーになる
  - title: ダッシュボード
    details: 一覧と詳細, 手動リトライ, 取り消しが最初から動く. 認証はfail-closedで, 設定するまでAPIもUIも404
  - title: performerの配置は自由
    details: service binding越しに別Workerへ置ける. 投入するだけのWorkerはDurable Objectの実装をバンドルしなくてよい
---
