# ダッシュボードと認証

::: warning
`auth`を設定しない限り、REST API/ダッシュボードが有効になりません。これはセキュリティのためであり、`fetch`はすべて404を返します。
:::

## bearerAuth

シークレット1つで認証を行う場合、`bearerAuth`を利用することができます。

```ts
import { bearerAuth, defineTsumugi } from 'tsumugi';

const tsumugi = defineTsumugi({
  performers,
  auth: bearerAuth((env: Env) => env.TSUMUGI_TOKEN, { cookie: 'tsumugi_token' }),
});
```
文字列で直接指定した場合、リポジトリとバンドルの両方にトークンが残ってしまうため、関数を通して取得することを推奨します。

認証時のトークン検証は、定数時間で比較されるため、トークンの長さが異なる場合でも処理時間の差から値が推測されることはありません。

### cookie

`cookie`オプションを明示することで、ブラウザからのアクセス時にcookieを利用して認証することができます。

ブラウザは最初のHTML取得時に`Authorization`ヘッダを付けないため、ダッシュボードを開く場合はこの設定が必要です。

cookieで受け取る構成はCSRFの対象になり得るため、発行側で適宜`SameSite=Strict`を指定してください。

## Cloudflare Access

`cloudflareAccess`を指定すると、Accessから発行されたJWTの検証をTsumugi側で行うようになります。

```ts
import { cloudflareAccess, defineTsumugi } from 'tsumugi';

const tsumugi = defineTsumugi({
  performers,
  auth: cloudflareAccess({ teamDomain: 'example', aud: 'audience tag' }),
});
```

| 名前         | 内容                                    |
| ------------ | --------------------------------------- |
| `teamDomain` | `<team>.cloudflareaccess.com`のteam部分 |
| `aud`        | Accessアプリケーションのaudience tag    |
| `cacheTtlMs` | JWKSの再取得間隔。既定は1時間           |

また、`auth`には任意のHonoミドルウェアを指定することも可能です。

## 認証を行わない構成 {#unsafe-no-auth}

::: danger
`unsafeNoAuth`を指定すると、認証無しにREST API/ダッシュボードが誰でも利用できる状態になります。
Workerへ到達できる全員が、payloadを含むジョブの内容の閲覧、任意のジョブの投入、取り消しと再実行を行えるため、公開環境では絶対に使用しないでください。
:::

Cloudflare Accessをルート全体へ適用している構成や、`wrangler dev`での確認のように、手前で認証している場合にのみ使用してください。
無認証を許可するにはこれを明示的に指定する必要があります。

```ts
import { defineTsumugi, unsafeNoAuth } from 'tsumugi';

const tsumugi = defineTsumugi({
  performers,
  auth: unsafeNoAuth(),
});
```

この設定が有効な間はisolate単位で警告がログへ出力されます。


## ダッシュボード

`tsumugi/ui`の`ui()`を`defineTsumugi`に渡すことで、ダッシュボードを有効にすることができます。

```ts
import { ui } from 'tsumugi/ui';

const tsumugi = defineTsumugi({
  performers,
  auth: bearerAuth((env: Env) => env.TSUMUGI_TOKEN, { cookie: 'tsumugi_token' }),
  ui: ui({ tokenCookie: 'tsumugi_token' }),
});
```

指定のない場合はバンドルに含まれません。

![ジョブの一覧画面](/dashboard-jobs.jpg)

### 時刻表示

定期実行の時刻は各スケジュールの`time_zone`で表示します。その他の時刻はブラウザのIANAタイムゾーンで表示します。
全ての時刻にIANAタイムゾーンと、その時点のGMTオフセットが含まれます。これは、通常のDSTの切り替えや、ブラウザのタイムゾーンが変更された場合でも、正しい時刻を確認するためです。

作成日時の範囲入力はブラウザのローカル日付で行います。UTCや他のタイムゾーンでの入力は現状サポートされていません。

### オプション

| 名前          | 内容                                                       |
| ------------- | ---------------------------------------------------------- |
| `tokenCookie` | トークンを保存するcookie名。`bearerAuth`の`cookie`と揃える |

`tokenCookie`を指定すると、APIが401を返した場合に入力欄が表示されるようになります。


### 機能

- 状態とbindingによる絞り込み、ページング、列ごとの並べ替え
- ジョブID、`uniqueKey`、`concurrencyKey`による検索
- 作成日時の範囲での絞り込み
- 詳細画面での試行履歴と進捗の表示
- 手動リトライと取り消し
- 選択したジョブへの一括リトライと一括取り消し
- ダッシュボードからのジョブ投入


行の左端のチェックボックスでジョブを選択します。見出し行のチェックボックスは表示中の行をまとめて選択、1件以上を選択するとメニューが表示され、リトライと取り消しをまとめて実行可能です。

検索欄は各フィールドの値を入力して検索します。いずれも完全一致です。
ジョブIDの形式に一致する値を入力した場合は、そのジョブの詳細画面を直接開きます。

### 表示の調整

いずれの設定もブラウザに保存され、次回以降も適用されます。

- 更新間隔: Off / 1s / 3s / 10s / 30s / 1mから選択します。既定は3秒です
- 列の表示切替: ID / Started at / Updated at / Attempts / Processing timeの表示を切り替えます。BindingとStatusは常に表示されます
- 1ページの件数: 10 / 20 / 30 / 50から選択します

### Runs

`flows`を設定している場合、ヘッダーにRunsのタブが表示されます。
`flows`が空の構成ではタブを表示しません。

一覧にはFlow、状態、ノードの進捗が表示されます。Flowと状態による絞り込みが可能です。
行を選択するとグラフが表示され、依存関係、各ノードの状態、fan-outノードの子ノードの進捗が並びます。

![Runの詳細とグラフ](/dashboard-run.jpg)
子ノードの表示は24件までで、超えた分は状態別の件数に集約されます。
ノードのJobを選択すると、そのジョブの詳細画面へ移動します。

subflowとして起動されたRunの詳細からは親のRunへ、subflowノードからは子のRunへ移動できます。

Runの開始、再開、取り消しもこの画面から実行します。
再開の対象は`FAILED`のRun、取り消しの対象は`RUNNING`のRunのみです。

### 試行履歴

詳細画面には試行ごとの開始時刻、終了時刻、エラーが表示されます。

![試行履歴の表示](/dashboard-attempts.jpg)

- エラー本文は2,000文字まで
- 1ジョブあたり20件まで保持する
- 一覧には含まれず、詳細でのみ取得できる
- 1回目で成功した試行は履歴に残らない

### リトライの可否

一覧の各行には`retryable`が含まれます。
これは、通常`FAILED`または`STALLED`であり、かつ保持期間内であるかの判定です。

実行可否を事前に表示するための近似値であり、実際の可否を保証するものではありません。
原則として、保持期間を過ぎたジョブへのリトライは410を返す挙動になっています。
