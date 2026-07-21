# ADR-0025:ダッシュボードは単一HTML文字列として`tsumugi/ui`から提供する

## 状況

`[site]`はWrangler v4で非推奨,後継のStatic Assetsは1 Workerにつき1コレクションのみでユーザー自身のアセットと併存できない

## 決定

Vueで構成されるSPAをViteで単一HTML(JS/CSSインライン)にビルドし,文字列としてJSに焼き込む
本体エントリではなく`tsumugi/ui`という別サブパスから提供する
スタイルはTailwindCSSとHeadless UI,ベースにkiso.cssを敷く

## 帰結

文字列定数はV8がコードとして解析しないので起動時間への影響はほぼない
別サブパスにすることで数百KBの文字列を全利用者のバンドルに強制しない
