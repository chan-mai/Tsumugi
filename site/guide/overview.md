# 概要

TsumugiはCloudflareスタック上でジョブを実行し管理するためのライブラリです

## 何を解決するか

Cloudflare Queuesをそのままジョブキューとして使う場合、次の制約があります

### 状態を管理できず、成功したジョブが残らない

投入したメッセージの現在の状態を問い合わせるAPIがありません
成功したメッセージは削除されるため、過去の実行結果を後から参照できません

Tsumugiは全状態をD1の読み取りモデルへ投影します
稼働中のジョブも終端に達したジョブも同じテーブルに入るため、一覧と検索と集計を通常のSQLで記述できます
失敗率や実行時間などの時系列データはAnalytics Engineへ別に書き出すため、D1の保持期間による削除の影響を受けません

### 排他制御と重複抑制を実装しにくい

他のメッセージを参照できないため、「同じ顧客のジョブを同時に実行しない」「同じ内容を二重に投入しない」のいずれも独自に実装する必要があります

Tsumugiはbinding単位のDurable Objectで稼働中ジョブの状態を一元管理します
Durable Objectはシングルスレッドであるため、検査と挿入が追加の仕組みなしで不可分になります
`concurrencyKey`を指定するとキー単位で直列化され、`uniqueKey`を指定すると衝突時に既存のジョブIDが返ります

### プロデューサーとコンシューマーが1対1

ジョブの種類が増えるほど、キューを増やすかconsumer側の分岐を増やすかのいずれかが必要になります

Tsumugiではキューを1本に保ち、種類をbinding名で区別します
binding名とperformerの対応は登録簿1箇所に記述し、payloadの型もそこから推論されます

### 多段の処理を構成できない

前のジョブの戻り値を次のジョブへ渡す、複数の結果が揃ってから次へ進むといった依存関係を表現する手段がありません

Tsumugiはflowとしてグラフを定義し、その実行単位をrunとして管理します
前段の戻り値から後段のpayloadを組み立てる関数はflowの定義に記述し、型検査もそこで適用されます
実行時に件数が決まる並列処理はfan-out、`perform`の内部からノードを追加する場合は`ctx.spawn`を使用します
詳細は[DAG(flowとrun)](/guide/flow)を参照してください

### メッセージが消失する場合がある

Queuesへ投入したままでは、消失を検知する手段がありません

Tsumugiが正として扱うのはDurable ObjectのSQLiteであり、Queuesではありません
Queuesが担当するのは実行のスケーリングのみです
タイムアウト後も報告が来ないジョブはreaperが回収し、at-least-onceでは再投入、at-most-onceでは`STALLED`へ遷移させて手動での判断を待ちます

## Tsumugiが行うこと

上記の5点は、QueuesにDurable ObjectとD1とAnalytics Engineを組み合わせれば解決できます
ただし、どのDurable Objectへ投入するか、consumerで何を実行するか、状態をいつD1へ書き込むか、リトライをどこで判断するかの実装が必要です

Tsumugiはこれらの実装を内部に持ちます
利用者が記述するのは次の2点です

```ts
// 1. ジョブの処理内容をperformerとして定義する
class SendMail extends Performer<{ to: string }, void, {}, Env> {
  async perform(payload: { to: string }): Promise<void> {
    await this.env.MAILER.send(payload.to);
  }
}

// 2. 登録して投入する
const tsumugi = defineTsumugi<Env>({ performers: { MAIL: SendMail } });

const id = await enqueue(env, { binding: 'MAIL', payload: { to: 'a@example.com' } });
```

キューの構成、consumerの分岐、読み取りモデルへの投影は利用者が意識する必要がありません
リトライ、バックオフ、予約実行、優先度、流量制御、重複排除、管理画面はライブラリ側が提供します

## 構成要素

| リソース         | 役割                                                      |
| ---------------- | --------------------------------------------------------- |
| Durable Object   | binding単位のスケジューラ、稼働中ジョブの状態を保持する   |
| Durable Object   | run単位の調停役、DAGを使う場合のみ作成される              |
| Queues           | performerの実行とスケーリング、配送保証は担当しない       |
| D1               | 読み取りモデル、一覧と検索と集計の参照先                  |
| Analytics Engine | 時系列メトリクス                                          |

## ジョブの経路

1. `enqueue`が投入先のDurable Objectを決定して渡します。`uniqueKey`が既存と衝突した場合は既存のジョブIDが返ります
2. Durable ObjectがSQLiteへ書き込み、alarmを設定します。判断は`schedule()`という純粋関数に分離しています
3. Durable ObjectはQueuesへ投入した時点で処理を終了します。performerを直接awaitしません
4. consumerがperformerを実行し、結果をDurable Objectへ報告した後、常に即座にackします
5. Durable Objectがリトライの要否を判断します。試行回数とバックオフもDurable Objectが保持します
6. 状態遷移はアウトボックス経由で数秒ごとにD1へバッチ投影されます

DAGを使う場合はDurable Objectが1種類増えます
Run DOはrun 1件につき1インスタンスで、ノードの投入と依存関係の解決を担当します
ジョブの完了はJob DOのアウトボックス経由でRun DOへ送られ、送信に失敗した場合は次のtickで再送されます

performerを直接awaitしない理由は、Durable Objectの課金がwall-clock durationに基づくためです
10分かかるジョブの実行中にDurable Objectのリクエストが生存し続けると、その時間分が課金されます

D1への投影は数秒遅れる読み取りモデルであり、正しさの根拠には使用できません
ダッシュボードの表示もその分だけ遅れます

## 必要なもの

- Workers Paidプラン。SQLite版のDurable ObjectsとQueuesの両方が要求します
- `compatibility_date`は2025-11-17以降。`ctx.exports`を使用するためです

## 着想

Cloudflareスタックだけでジョブキューを組み、ダッシュボードを同梱するという構成は[Kiribi](https://kiribi.pages.dev/)からインスパイアを得ています
TsumugiはこれにDurable Objectによる状態の一元管理を加え、流量制御と実行保証とリトライの判断をDurable Object側に配置したものです
