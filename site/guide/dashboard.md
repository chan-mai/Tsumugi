---
title: ダッシュボードと認証
description: REST APIとダッシュボードの認証の設定と、ダッシュボードでのジョブとRunの参照, 検索, 一括操作について
publishedAt: 2026-07-22
updatedAt: 2026-10-25
---

# ダッシュボードと認証

::callout{type="warning"}
`auth`を指定しない場合、REST APIとダッシュボードへのすべてのリクエストに404で応答します。
::

## bearerAuth

`bearerAuth`は、単一のトークンを用いてリクエストを認証します。

```ts
import { bearerAuth, defineTsumugi } from 'tsumugi';

const tsumugi = defineTsumugi({
  performers,
  auth: bearerAuth((env: Env) => env.TSUMUGI_TOKEN, { cookie: 'tsumugi_token' }),
});
```

トークンは、上の例のように関数でSecretから取得してください。
文字列で直接記述すると、リポジトリとバンドルの両方にトークンが含まれるため、セキュリティ上のリスクが生じます。

### cookie

`cookie`オプションを指定すると、`Authorization`ヘッダに加えて、指定した名前のcookieに含まれるトークンも検証されます。
ブラウザは最初のHTML取得時に`Authorization`ヘッダを付与しません。
ダッシュボードを開くには、この設定が必ず必要です。

cookieによる認証は、CSRFの対象になる可能性があります。
cookieを発行する側では、`SameSite=Strict`を明示的に指定してください。

## Cloudflare Access

`cloudflareAccess`を指定すると、Cloudflare Accessが発行したJWTを検証します。
`auth`は、`bearerAuth`, `cloudflareAccess`, `unsafeNoAuth`の戻り値に加えて、任意のHonoミドルウェアも受け入れます。

```ts
import { cloudflareAccess, defineTsumugi } from 'tsumugi';

const tsumugi = defineTsumugi({
  performers,
  auth: cloudflareAccess({ teamDomain: 'example', aud: 'audience tag' }),
});
```

| 名前 | 内容 |
| --- | --- |
| `teamDomain` | `<team>.cloudflareaccess.com`のteam部分 |
| `aud` | Accessアプリケーションのaudience tag |
| `cacheTtlMs` | JWKSの再取得間隔。既定は1時間 |

## 認証しない構成

::callout{type="danger"}
`unsafeNoAuth`を指定すると、REST APIとダッシュボードは認証を要求しません。
Workerにアクセスできるすべての利用者が、payloadを含むジョブの内容を閲覧し、ジョブを投入, 取り消し, 再実行できます。
公開環境では使用しないでください。
::

`unsafeNoAuth`は、Tsumugiより前段で認証している場合に限って使用します。
Cloudflare Accessをルート全体に適用している構成や、`wrangler dev`での動作確認が該当します。
認証しない場合は、`auth`を省略せず、`unsafeNoAuth`を明示してください。
`unsafeNoAuth`を指定している間、ログに警告が出力されます。

```ts
import { defineTsumugi, unsafeNoAuth } from 'tsumugi';

const tsumugi = defineTsumugi({
  performers,
  auth: unsafeNoAuth(),
});
```

## ダッシュボードの有効化

`tsumugi/ui`の`ui()`を`defineTsumugi`の`ui`に渡すと、`/api`以外のパスへのGETリクエストに対してダッシュボードのHTMLで応答します。
`ui`を指定しない場合、ダッシュボードはバンドルに含まれません。
APIが401で応答すると、ダッシュボードはトークンの入力欄を表示します。

```ts
import { ui } from 'tsumugi/ui';

const tsumugi = defineTsumugi({
  performers,
  auth: bearerAuth((env: Env) => env.TSUMUGI_TOKEN, { cookie: 'tsumugi_token' }),
  ui: ui({ tokenCookie: 'tsumugi_token' }),
});
```

| 名前 | 内容 |
| --- | --- |
| `tokenCookie` | トークンを保存するcookieの名前。`bearerAuth`の`cookie`と同じ値 |

## ジョブの一覧

ジョブの一覧では、状態, binding, 作成日時の範囲でフィルタし、ページングと列ごとの並べ替えを操作します。
ジョブID, `uniqueKey`, `concurrencyKey`による検索機能も備えています。
ジョブの詳細ページには、試行履歴, 進捗, ログ, トレース情報が表示されます。
手動のリトライと取り消し, 選択したジョブの一括リトライと一括取り消し, ジョブの投入も、ジョブの一覧ページで操作します。

![ジョブの一覧ページ](/dashboard-jobs.jpg)

### 検索

検索欄に入力した値は、完全一致で検索されます。
ジョブIDの形式に一致する値を入力した場合、そのジョブの詳細が表示されます。

### 一括操作

行の左端のチェックボックスで、ジョブを選択します。
見出し行のチェックボックスは、表示中のすべての行を選択します。
1件以上を選択すると、選択したジョブをまとめてリトライまたは取り消すメニューが表示されます。

### 表示の設定

表示の設定は、ブラウザに保存され、次回以降も適用されます。
更新間隔は、Off, 1s, 3s, 10s, 30s, 1mから選択し、既定値は3秒です。
列の表示は、ID, Started at, Updated at, Attempts, Processing timeを切り替え可能です。
BindingとStatusは、常に表示されます。
1ページの件数は、10, 20, 30, 50から選択します。
言語は、サイドバーの下部で日本語とEnglishを切り替えます。
初回は、ブラウザの言語設定に従います。

### 時刻の表示

定期実行の時刻は、各スケジュールのタイムゾーンで表示されます。
その他の時刻は、ブラウザのIANAタイムゾーンで表示されます。
すべての時刻に、IANAタイムゾーンとGMTオフセットが併記されます。
作成日時の範囲は、ブラウザのローカル日付の年月日で指定します。

## ジョブの詳細

### 試行履歴

試行ごとの開始時刻, 終了時刻, エラーがジョブの詳細に表示されます。
保存される件数とエラー本文の長さの上限は、[失敗とリトライ](/guide/performer#失敗とリトライ)を参照してください。
試行履歴はジョブの詳細のレスポンスにのみ含まれ、一覧のレスポンスには含まれません。
1回目で成功した試行は履歴に記録されません。

![試行履歴の表示](/dashboard-attempts.jpg)

### ログとトレース情報

`ctx.log()`で保存したメッセージは、受信順にジョブの詳細に表示されます。
各ログには、試行回数, 記録時刻, 本文が含まれます。
実行中のジョブのログも表示されますが、表示まで時間を要する可能性があります。
保存される件数, 本文の長さ, 保存間隔の上限は、[ログ](/guide/performer#ログ)を参照してください。
ログの保持期間は、ジョブの保持期間と同一です。

投入時に`traceparent`を指定したジョブでは、その値がジョブの詳細に表示されます。
performerでの利用方法は、[トレース情報](/guide/performer#トレース情報)を参照してください。

### リトライ可否の表示

一覧の各行には、`retryable`が含まれます。
`retryable`は、ジョブが`FAILED`または`STALLED`であり、かつ保持期間内であるかどうかを示す指標です。
リトライの成功は保証されません。
保持期間を過ぎたジョブに対するリトライ要求には、REST APIが410で応答します。

## Runs

`flows`を設定している場合、サイドバーにRunsの項目が表示されます。
`flows`が空の場合、表示されません。

Runの一覧は、Flow, 状態, ノードの進捗を表示します。
Flowまたは状態を指定すると、一致するRunに限って一覧に表示されます。
行を選択すると、詳細パネルが開きます。
詳細パネルは、グラフとウォーターフォールの2種類の表示を提供します。

![Runのウォーターフォール](/dashboard-run.jpg)

ウォーターフォールは、各ノードの実行時間を時間軸上に並べた表示です。
グラフは、ノードの依存関係, 各ノードの状態, fan-outのノードの子ノードの進捗を表示します。
子ノードは24件まで表示され、超過分は状態ごとの件数で示されます。
ウォーターフォールの行やグラフのノードを選択すると、そのジョブの詳細が開きます。

subflowとして開始されたRunの詳細には、親のRunのIDがリンクで表示されます。
このリンクを選択すると、親のRunの詳細が開きます。
グラフ上のsubflowのノードには、子のRunの詳細を開くボタンがあります。
ウォーターフォールのsubflowの行を選択しても、子のRunの詳細が開きます。

Runの開始, 再開, 取り消しは、Runsのページで操作します。
再開の対象は`FAILED`のRun, 取り消しの対象は`RUNNING`のRunです。
