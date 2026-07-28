# ダッシュボードと認証

::: warning
`auth`を設定するまで、REST APIもダッシュボードも有効になりません。`fetch`はすべて404を返します。
:::

## bearerAuth

シークレット1つで設定します

```ts
import { bearerAuth, defineTsumugi } from 'tsumugi';

const tsumugi = defineTsumugi({
  performers,
  auth: bearerAuth((env: Env) => env.TSUMUGI_TOKEN, { cookie: 'tsumugi_token' }),
});
```

トークンは関数で渡します。文字列を直接書くとリポジトリとバンドルの両方に残ります

比較は長さも含めた定数時間で行うため、処理時間の差から値が推測されることはありません

### cookie

`cookie`オプションを指定すると、同じトークンをcookieからも受け取ります

ブラウザは最初のHTML取得時に`Authorization`ヘッダを付けないため、ダッシュボードを開く場合はこの設定が必要です

cookieで受け取る構成はCSRFの対象になります。発行側で`SameSite=Strict`を指定してください

## Cloudflare Access

`cloudflareAccess`を指定すると、JWTの検証をTsumugi側で行います

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

`auth`には任意のHonoミドルウェアを指定します。独自の認証の組み込みも可能です

## ダッシュボード

`tsumugi/ui`の`ui()`を`defineTsumugi`に渡すと有効になります

```ts
import { ui } from 'tsumugi/ui';

const tsumugi = defineTsumugi({
  performers,
  auth: bearerAuth((env: Env) => env.TSUMUGI_TOKEN, { cookie: 'tsumugi_token' }),
  ui: ui({ tokenCookie: 'tsumugi_token' }),
});
```

サブパスに分割しているため、指定しない場合はバンドルに含まれません

### オプション

| 名前          | 内容                                                                 |
| ------------- | -------------------------------------------------------------------- |
| `basePath`    | マウント先のパス                                           |
| `tokenCookie` | トークンを保存するcookie名。`bearerAuth`の`cookie`と揃える  |

`tokenCookie`を指定すると、APIが401を返したときに入力欄が表示されます
Cloudflare Accessのようにブラウザ側で認証が完結する構成では不要です

::: warning 現状の制約
`basePath`を指定した配置は現時点では動作しません。ダッシュボードはルート(`/`)に配置してください
:::

### 機能

- 状態とbindingによる絞り込み、ページング、列ごとの並べ替え
- ジョブID、`uniqueKey`、`concurrencyKey`による検索
- 作成日時の範囲での絞り込み
- 詳細画面での試行履歴の表示
- 手動リトライと取り消し
- 選択したジョブへの一括リトライと一括取り消し
- ダッシュボードからのジョブ投入


行の左端のチェックボックスでジョブを選択します。見出し行のチェックボックスは表示中の行をまとめて選択、1件以上を選択するとメニューが現れ、リトライと取り消しをまとめて実行可能です

検索欄では対象を切り替えます。いずれも完全一致です
ジョブIDの形式に一致する値を入力した場合は、そのジョブの詳細画面を直接開きます

### 表示の調整

いずれの設定もブラウザに保存され、次回以降も適用されます

- 更新間隔: Off / 1s / 3s / 10s / 30s / 1mから選択します。既定は3秒です
- 列の表示切替: ID / Started at / Updated at / Attempts / Processing timeの表示を切り替えます。BindingとStatusは常に表示されます
- 1ページの件数: 10 / 20 / 30 / 50から選択します

### Runs

`flows`を設定している場合、ヘッダーにRunsのタブが表示されます
`flows`が空の構成ではタブを表示しません

一覧にはFlow、状態、ノードの進捗が表示されます。Flowと状態による絞り込みが可能です
行を選択するとグラフが表示され、依存関係、各ノードの状態、fan-outノードの子ノードの進捗が並びます
子ノードの表示は24件までで、超えた分は状態別の件数に集約されます
ノードのJobを選択すると、そのジョブの詳細画面へ移動します

subflowとして起動されたRunの詳細からは親のRunへ、subflowノードからは子のRunへ移動できます

Runの開始、再開、取り消しもこの画面から実行します
再開の対象は`FAILED`のRun、取り消しの対象は`RUNNING`のRunのみです

### 試行履歴

詳細画面には試行ごとの開始時刻、終了時刻、エラーが表示されます
何回目の試行でどのように失敗したかは、ここで確認します

- エラー本文は2,000文字で打ち切る
- 1ジョブあたり20件まで保持する
- 一覧では返さない。1画面で数百KBに達する場合があるため
- 1回目で成功した試行は保存しない。ジョブの行から導出するため

### リトライの可否

一覧の各行には`retryable`が含まれます
`FAILED`または`STALLED`であり、かつ保持期間内であるかの判定です

実行可否を事前に表示するための近似値です
保持期間を過ぎたジョブへのリトライは410を返します
