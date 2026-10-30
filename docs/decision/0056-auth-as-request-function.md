# ADR-0056: authをRequestを受け取る関数で表す

## 状況

`auth`はHonoの`MiddlewareHandler`を受け取り、任意のHonoミドルウェアを指定できた(ADR-0013)
ADR-0055でHonoへの依存を外すため、公開型からHonoの型を除く必要がある
同梱の`bearerAuth`, `cloudflareAccess`, `unsafeNoAuth`が読むのは、リクエストのヘッダとcookie, `env`の値だけである

## 決定

`auth`の型を`(request, env) => Response | undefined | Promise<Response | undefined>`とする
`undefined`は認証成功として後続の処理へ進め、`Response`は拒否としてそのまま返す
同梱の3関数は、呼び出し方を変えずにこの型で実装する
`createRest`の戻り値は、`fetch`と登録経路の一覧を持つオブジェクトとする
`cloudflareAccess`が設定していたHonoのContext変数`accessClaims`は、読み出す箇所が無いため廃止する

## 帰結

同梱の3関数を使う利用者はコードの変更が不要
独自のHonoミドルウェアを`auth`へ渡していた利用者は、関数の書き換えが必要になる
`createRest`の戻り値をHonoのアプリケーションとして扱っていた利用者も、書き換えが必要になる
認証関数から後続の処理へ値を渡す手段は無い
