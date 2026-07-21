# ADR-0024: `ctx.exports`による自己参照を前提にする

## 状況

自己参照のservice bindingは初回デプロイで解決できず,設定をコメントアウトして2回デプロイする回避手順が要る

## 決定

`ctx.exports`で自己参照のservice bindingを自動生成させる

## 帰結

導入時の離脱要因が消える

当初はcompat flag `enable_ctx_exports`の設定を利用者に要求する想定だったが,実際に動かして不要と判明した
このフラグは2025-11-17以降のcompatibility_dateで既定有効になっており,明示指定するとworkerdが起動時にエラーを出す
利用者に要求するのはcompatibility_dateを2025-11-17以降にすることだけで済む
