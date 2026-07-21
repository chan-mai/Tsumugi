# 概要

TsumugiはCloudflareスタックの上で安定してジョブを捌くためのライブラリです

## 何を解決するか

Cloudflare Queuesをそのままジョブキューとして使うと、いくつか困ることがあります

### ステータスが管理しづらく、成功したジョブは揮発する

投げたメッセージの現在の状態を問い合わせるAPIがありません
成功したものは消えるので、過去の実績を後から参照することもできません

Tsumugiは全状態をD1の読み取りモデルへ投影します
稼働中も終端後も同じテーブルに並ぶので、一覧も検索も集計も通常のSQLで書けます
失敗率や実行時間のような時系列データはAnalytics Engineに別途書き出すので、D1のcleanupに巻き込まれません

### 排他制御や重複抑制がし辛い

他メッセージを参照できないため、「同じ顧客のジョブは同時に走らせない」も「同じ内容は二重に入れない」も自前で組む必要があります

Tsumugiはbinding単位のDurable Objectで稼働中ジョブの状態を一元管理します
Durable Objectはシングルスレッドなので、検査と挿入が追加の仕組みなしで不可分になります
`concurrencyKey`を渡せばキー単位で直列化され、`uniqueKey`を渡せば衝突時に既存のジョブIDが返ります

### プロバイダーとコンシューマーが1対1

ジョブの種類が増えるほど、キューを増やすかconsumer側の分岐が膨らむかのどちらかになります

Tsumugiではキューは1本のまま、種類をbinding名で分けます
binding名とperformerの対応は登録簿1箇所に書けば済み、ペイロードの型もそこから推論されます

### たまにキューが消失する

Queuesに預けたきりだと、消失を検知する手段がありません

Tsumugiが正として扱うのはDurable ObjectのSQLiteであってQueuesではありません
Queuesが担当しているのは実行のスケーリングだけです
タイムアウトを過ぎても報告が来ないジョブはreaperが回収し、at-least-onceなら再投入、at-most-onceなら`STALLED`に落として手動での判断を待ちます

## Tsumugiがすること

上の4つは、Queuesの上にDurable ObjectとD1とAnalytics Engineを重ねれば解けます
ただし配線が要ります。どのDurable Objectへ投げるか、consumerで何を実行するか、状態をいつD1へ書くか、リトライを誰が決めるか

Tsumugiはその配線を中に持ちます
あなたが書くのは2つだけです

```ts
// 1. ジョブの中身をperformerとして定義する
class SendMail extends Performer<{ to: string }, void, {}, Env> {
  async perform(payload: { to: string }): Promise<void> {
    await this.env.MAILER.send(payload.to);
  }
}

// 2. 登録して投入する
const tsumugi = defineTsumugi<Env>({ performers: { MAIL: SendMail } });

const id = await enqueue(env, { binding: 'MAIL', payload: { to: 'a@example.com' } });
```

キューもconsumerの分岐も読み取りモデルも意識する必要はなく、リトライ、バックオフ、予約実行、優先度、流量制御、重複排除、管理画面をすべていい感じにブラックボックスとして扱うことができます。


## 構成要素

| リソース         | 役割                                                    |
| ---------------- | ------------------------------------------------------- |
| Durable Object   | binding単位のスケジューラ、稼働中ジョブの状態を保持する |
| Queues           | performerの実行とスケーリング、配送保証は担当しない     |
| D1               | 読み取りモデル、一覧と検索と集計はここから引く          |
| Analytics Engine | 時系列メトリクス                                        |

## ジョブ経路

1. `enqueue`が投入先のDurable Objectを決めて渡します。`uniqueKey`が既存と衝突した場合は既存のジョブIDが返ります
2. Durable ObjectがSQLiteに書いてalarmを設定します。判断は`schedule()`という純粋関数に切り出してあります
3. Durable ObjectはQueuesへ投入した時点で処理を終えます。performerを直接awaitしません
4. consumerがperformerを実行し、結果をDurable Objectへ報告して必ず即ackします
5. Durable Objectがリトライの要否を決めます。試行回数もバックオフもここが持ちます
6. 状態遷移はアウトボックス経由で数秒ごとにD1へバッチ投影されます

performerを直接awaitしないのは、Durable Objectの課金がwall-clock durationベースだからです
10分かかるジョブの間ずっとDurable Objectのリクエストが生存していると、その分だけ課金されます

D1への投影は数秒遅れる読み取りモデルなので、正しさの根拠には使えません
ダッシュボードの表示は多少遅れますが、秒単位の鮮度は不要という判断です

## 必要なもの

- Workers Paidプラン。SQLite版のDurable ObjectsとQueuesの両方が要求します
- `compatibility_date`は2025-11-17以降。`ctx.exports`を使うためです

## 着想

Cloudflareスタックだけでジョブキューを組み、ダッシュボードを同梱するという構成は[Kiribi](https://kiribi.pages.dev/)からインスパイアを得ています
TsumugiはそこにDurable Objectによる状態の一元管理を加え、流量制御と実行保証とリトライの制御をDurable Object側へ寄せたものです
