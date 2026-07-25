# ダッシュボードと認証

::: warning
`auth`を設定するまで、REST APIもダッシュボードも有効になりません。`fetch`はすべて404を返します。
:::

## bearerAuth

シークレット1つで始められます

```ts
import { bearerAuth, defineTsumugi } from 'tsumugi';

const tsumugi = defineTsumugi<Env>({
  performers,
  auth: bearerAuth((env: Env) => env.TSUMUGI_TOKEN, { cookie: 'tsumugi_token' }),
});
```

トークンは関数で渡します
Cloudflareのsecretは`env`経由でしか読めないため、モジュール初期化時には参照できません
文字列を直接書くとリポジトリとバンドルの両方に残ります

比較は長さも含めた定数時間で行うので、処理時間の差から推測されることはありません

### cookie

`cookie`オプションを付けると、同じトークンをcookieからも受け取ります

ブラウザは最初のHTML取得時に`Authorization`ヘッダを付けられないため、ダッシュボードを開くにはこの設定が必要です

cookieで受け取る以上CSRFの対象になります。発行側で`SameSite=Strict`を付けてください

## Cloudflare Access

`cloudflareAccess`を使うと、JWTの検証をTsumugi側で行えます

```ts
import { cloudflareAccess, defineTsumugi } from 'tsumugi';

const tsumugi = defineTsumugi<Env>({
  performers,
  auth: cloudflareAccess({ teamDomain: 'example', aud: 'audience tag' }),
});
```

| 名前         | 内容                                    |
| ------------ | --------------------------------------- |
| `teamDomain` | `<team>.cloudflareaccess.com`のteam部分 |
| `aud`        | Accessアプリケーションのaudience tag    |
| `cacheTtlMs` | JWKSの再取得間隔。既定は1時間           |

任意のHonoミドルウェアを渡せるので、独自の認証も組み込めます

## ダッシュボード

`tsumugi/ui`の`ui()`を`defineTsumugi`に渡すと有効になります

```ts
import { ui } from 'tsumugi/ui';

const tsumugi = defineTsumugi<Env>({
  performers,
  auth: bearerAuth((env: Env) => env.TSUMUGI_TOKEN, { cookie: 'tsumugi_token' }),
  ui: ui({ tokenCookie: 'tsumugi_token' }),
});
```

サブパスに分割しているため、指定しない場合はバンドルに含まれません

### オプション

| 名前          | 内容                                                                 |
| ------------- | -------------------------------------------------------------------- |
| `basePath`    | マウント先のパス。ビルド時には決められないので配信時にHTMLへ注入する |
| `tokenCookie` | トークンを保存するcookie名。`bearerAuth`の`cookie`と揃える           |

`tokenCookie`を指定すると、APIが401を返したときに入力欄が表示されます
Cloudflare Accessのようにブラウザ側で認証が完結する構成では不要です

`/admin`の下に置く場合はこう書きます

```ts
ui: ui({ basePath: '/admin', tokenCookie: 'tsumugi_token' });
```

### 機能

- 状態とbindingによる絞り込み、ページング、列ごとの並べ替え
- 状態別の件数の表示
- 詳細画面での試行履歴の表示
- 手動リトライと取り消し
- ダッシュボードからのジョブ投入

一覧の参照先はD1の読み取りモデルです
投影は数秒遅れるため、稼働中のジョブの表示もその分だけ遅れます

### Runs

`flows`を設定している場合、ヘッダーにRunsのタブが表示されます
`flows`が空の構成ではタブを表示しません

一覧にはflow、状態、ノードの進捗が表示されます
行を選択するとグラフが表示され、依存関係、各ノードの状態、fan-outノードの子ノードの進捗を確認できます
ノードのJobを選択すると、そのジョブの詳細画面へ移動します

runの開始、再開、取り消しもこの画面から実行できます
再開できるのは`FAILED`のrun、取り消せるのは`RUNNING`のrunのみです

### 試行履歴

詳細画面には試行ごとの開始時刻、終了時刻、エラーが表示されます
何回目の試行でどのように失敗したかを確認できます

- エラー本文は2,000文字で打ち切る
- 1ジョブあたり20件まで保持する
- 一覧では返さない。1画面で数百KBに達する場合があるため
- 1回目で成功した試行は保存しない。ジョブの行から導出できるため、表示のためだけに書き込みを増やさない

### リトライの可否

一覧の各行には`retryable`が含まれます
`FAILED`または`STALLED`であり、かつ保持期間内であるかの判定です

実行可否を事前に表示するための近似値であり、実際の可否を判定するのはDurable Objectです
保持期間を過ぎたジョブへのリトライは410を返します
