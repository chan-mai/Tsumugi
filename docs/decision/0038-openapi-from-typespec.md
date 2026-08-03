# ADR-0038: OpenAPI定義はTypeSpecから生成する

## 状況

REST APIのOpenAPI文書は`src/api/openapi.ts`に約670行の手書きオブジェクトとして持っていた(issue #39)
同じ仕様が`api/openapi.ts`(OpenAPI),`api/types.ts`(TSの型),`site/reference/rest-api.md`(散文)の3系統で手書きされ,経路やスキーマの変更のたびに並行して編集が必要となる
経路の網羅は単体テストで実装と突き合わせているが,スキーマの中身はOpenAPIの構文ごと目視で維持している

## 決定

OpenAPI文書の源泉をTypeSpec(`packages/spec`)へ移す

- `.tsp`がモデルと経路を持ち,`tsp compile`(`@typespec/openapi3`)がOpenAPI 3.1のJSONを生成する
- 生成物は`@tsumugi/dashboard`と同じ方式で配る。`emit-module.mjs`が`dist/index.js`の定数へ焼き込み,`prepare`がビルドし,tsdownの`noExternal`でバンドルへ畳み込む
- 生成器の表現差はemit時に従来の形へ正規化する。nullableの`anyOf`はtype配列へ,`unevaluatedProperties`は`additionalProperties`へ,既定値と同じ`explode` / `required`と空の`parameters`は落とす。意味が同じでも表現が変わると,利用者のクライアント生成物が移行だけで変わるため
- `API_VERSION`は`src/api/openapi.ts`に残し,配信時に`info.version`へ注入する。CI(version-check / release)の照合と版の単体テストの前提を変えない

## 帰結

- 経路やスキーマの追加は`.tsp`の編集だけになり,OpenAPIの構文を手書きしない
- 経路の網羅,503の記載,`$ref`の整合,並べ替え列の一致を見る既存の単体テストは,生成した文書に対してそのまま働く
- `api/types.ts`と文書の統合は範囲外。TypeSpecからの型生成へ寄せる余地は残る
- 定義の変更にはビルド(`pnpm --filter @tsumugi/spec build`)が要る。`prepare`が自動で行うため,通常の開発手順は変わらない
