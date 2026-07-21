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
  - title: 書くのは2つだけ
    details: performerクラスを定義して, enqueueを呼びます. どのDurable Objectへ渡すか, consumerで何を実行するか, 状態をいつD1へ書くかはTsumugiが持ちます
  - title: 非同期実行がメソッド呼び出しに見える
    details: enqueue(env, { binding, payload })でジョブIDが返ります. キューもconsumerの分岐も読み取りモデルも表に出てきません
  - title: 運用に要るものが最初から入っている
    details: リトライ, バックオフ, 予約実行, 優先度, 同時実行数とレートの制限, 重複排除, 管理画面が揃っています. 後から足す必要がありません
  - title: 成功したジョブも消えない
    details: 全状態がD1に投影されるので, 一覧も検索も集計も通常のSQLで書けます. 失敗率や実行時間はAnalytics Engineに残ります
  - title: 実行保証はジョブごとに選ぶ
    details: 既定はat-least-onceです. 二重実行が致命的なジョブだけat-most-onceにすると, 実行前にDurable Objectへclaimを取得します
  - title: performerの配置は自由
    details: service binding越しに別Workerへ置けます. 投入するだけのWorkerはDurable Objectの実装をバンドルせずに済みます
---
