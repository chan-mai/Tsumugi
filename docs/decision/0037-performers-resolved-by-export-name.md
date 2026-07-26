# ADR-0037: performerはexportした名前で解決しbindingの登録を廃止する

## 状況

`defineTsumugi`の`performers`はbinding名とperformerの対応表であり,ここが実行時の解決先を兼ねていた
performerを1つ増やすたびに,クラスの定義とこの表への追記の2箇所を書く必要がある

同種の製品であるKiribiでは,performerの追加でコード側にbinding名は出てこない
performerは`WorkerEntrypoint`の派生としてexportし,binding名との対応はwrangler設定の`services`だけが持つ

この差は専用CLI(ADR-0036)を作る際に問題になる
`add-performer`が対応表を維持するには,TypeScriptのソースを書き換えるか,追記を利用者の手作業として残すかのどちらかしかない

ADR-0024で`ctx.exports`による自己参照を前提に据えており,同一Worker内のperformerも`ctx.exports`から引ける
別Workerのperformerはservice bindingとして`env`から引ける(ADR-0026)
どちらも対応表を経由せずに解決できる

## 決定

performerの解決を「binding名でexportを引く」ことに一本化し,実行時の登録を廃止する

- performerは`Performer`(`WorkerEntrypoint`の派生)を継承し,エントリのトップレベルでexportする
- binding名はexportした名前をそのまま使う, 別名にしたい場合は`export { Hello as HELLO }`と書く
- consumerは`ctx.exports[binding]`,無ければ`env[binding]`の順に引く
- `performers`は型の導出だけに使う, performerのバレルをそのまま渡す形にする

同一Workerと別Workerで書き方を分けない
`RemotePerformer`は廃止し`Performer`に統合する,違いはwrangler設定に`services`を書くか否かだけになる
`remote()`は型を運ぶだけの印になり,引数のbinding名は取らない

### `signal`を`deadlineAt`へ置き換える

`AbortSignal`はRPCの引数として越えられないため,全performerがservice binding越しになる構成では`ctx.signal`を配れない
代わりに`ctx.deadlineAt`(timeoutが切れる時刻,epochミリ秒)を渡す
中断が要るperformerは`AbortSignal.timeout(ctx.deadlineAt - Date.now())`を自分で組み立てる

## 帰結

performerの追加はファイルを1つ作ってexportするだけになり,CLIが生成する対象もそのファイルだけになる

**`ctx.spawn`は別Workerからは`await`が要る**

関数はRPCのstubとして越えるため,別Workerのperformerからも`ctx.spawn`を呼べる(ADR-0032)
ただし呼び出しはRPCなので,`await`しないと`perform`の完了報告に間に合わず要求が落ちる

**起動時検証はexportの漏れを検出できない**

検証は`env`しか見ないため,`remote()`を置いたperformerのservice bindingの有無しか確かめられない(ADR-0036)
exportし忘れたperformerは投入後の実行時エラーとして現れる

**binding名がクラス名になる**

ジョブIDは`<binding>#<shard>:<localId>`なので(ADR-0005),ダッシュボードとジョブIDに出る名前がexport名になる

## 参照

- ADR-0010 キーはenqueue時に明示指定し型で必須化する, 型の導出元は`performers`のまま変えない
- ADR-0024 `ctx.exports`による自己参照を前提にする, 同一Worker内の解決先はこれ
- ADR-0026 performerをservice binding越しに置けるようにする, `remote('SERVICE_BINDING')`と`signal`非対応の記述を本ADRが置き換える
- ADR-0036 起動時検証は検出に徹しCLIが生成を担う, CLIの生成対象が本ADRで確定する
