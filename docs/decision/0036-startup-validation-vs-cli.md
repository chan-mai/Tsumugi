# ADR-0036: 起動時検証は検出に徹しCLIが生成を担う

## 状況

ADR-0017は`init`と`add-performer`を持つ専用CLIを将来作る方針とし,v0.1では起動時の設定検証で代替するとした
その起動時検証の範囲を定めないままなので,CLIとの分担が決まらず双方とも着手できていない

現状で検出できるのはマイグレーションの適用漏れ(`projection/migrations.ts`)と,run開始時のRUN binding未設定の2つのみ
それ以外のbindingの記述漏れは,ジョブを投入した後の実行時エラーとして現れる

## 決定

CLIは今作る,ADR-0017の後回しは取り消す
起動時検証とCLIの分担は「検証は検出,CLIは生成」とする

### 起動時検証が担う範囲

次の3つに限る

- 必須bindingの存在確認, 対象は`JOB_SHARD` / `TSUMUGI_DB` / `TSUMUGI_QUEUE`, flowを使う構成では`RUN`も含める
- performerのservice bindingの整合確認, 指した名前が`env`に在り`perform`を持つか(ADR-0026)
- 不足分について,wrangler設定へ貼り付けられる断片の出力

`TSUMUGI_METRICS`は必須にしない
未設定でもメトリクスが書かれないだけで,ジョブの実行は成立する

マイグレーションの適用そのものは`wrangler d1 migrations apply`に委ね,検証は未適用の検知に留める
検知は既存の`projection/migrations.ts`を再利用し,binding検証とは別の判定として並立させる

### CLIが担う範囲

- `tsumugi init` — D1とキューを作り,wrangler設定とWorkerの雛形を生成し,読み取りモデルのマイグレーションを適用する
- `tsumugi add-performer <NAME>` — performerのファイルを生成し,`services`へ追記する断片を出力する

D1の作成とマイグレーションの適用はCLIが`wrangler`を実行して行う
`wrangler d1 create`が出力するdatabase_idは生成した設定へそのまま書き込む,手で貼り直させると転記の誤りが入る可能性があるため

既存のファイルは書き換えない
`wrangler.jsonc`が既に在る場合は追記すべき断片を出力し,判断を利用者に残す

## 帰結

設定漏れはジョブの投入前に判明し,不足したbindingの断片がそのまま貼り付けられる
Workersに起動フックが無いため「初回の呼び出しを起動とみなす」形になり,検証は最初のリクエストまで走らない
検証できるのは`env`に見える範囲に限られ,wrangler設定そのものとの突き合わせはできない

CLIが生成する断片と起動時検証が出す断片は同じ実装から作る, 2箇所で書くと片方だけが古くなる

## 参照

- ADR-0013 認証をfail-closedにする, 設定漏れを動作しない状態として現す方針をbinding検証にも適用する
- ADR-0017 専用CLIを作る方針だがv0.1では後回しにする, 本ADRが後回しを取り消し範囲を確定する
- ADR-0026 performerをservice binding越しに置けるようにする, performerの整合確認はこの構成が前提
