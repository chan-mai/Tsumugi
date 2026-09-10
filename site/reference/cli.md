# CLI

`tsumugi`パッケージにはセットアップ用のCLIが含まれます。
インストールは不要で、パッケージを追加したプロジェクトで`npx tsumugi`を実行します。

## 対話モード

引数なしで起動すると対話モードになります。

```bash
npx tsumugi
```

パイプやCIなどTTYでない環境では対話モードに入らず、usageを出力し終了されます。

## tsumugi init

プロジェクトにTsumugiをセットアップします。

```bash
npx tsumugi init [--name <name>] [--format jsonc|toml]
```

実行される内容は次の通りです。

1. `wrangler queues create <name>`と`wrangler d1 create <name>`でリソースを作成
2. wrangler設定が無ければ生成。`wrangler d1 create`が出力した`database_id`書き込み
3. `src/index.ts`と`src/performers/`と`.dev.vars`の生成
4. `wrangler d1 migrations apply`(`--local`と`--remote`)と`wrangler types`を実行

### オプション

| オプション                | 内容                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| `--name <name>`           | Workerの名前。省略時は既存設定の`name`、`package.json`の`name`、ディレクトリ名の順で決まります |
| `--format <jsonc\|toml>`  | 生成する設定の形式。既定は`jsonc`                                                                 |

### 既存ファイルの扱い

意図しない上書きを避けるため、既存のファイルを書き換えることはありません。
wrangler設定(`wrangler.json` / `wrangler.jsonc` / `wrangler.toml`)が既にある場合は、その形式に合わせた追記するべき値を出力します。
`src/index.ts`などの雛形も、既にあるものはスキップされます。

## tsumugi add-performer

performerを追加します。

```bash
npx tsumugi add-performer <NAME>
```

1. `src/performers/<name>.ts`にperformerのクラスを生成
2. `src/performers/index.ts`へexport行を1行追記

名前はkebab-case / camelCase / PascalCase / SNAKE_CASEのいずれも指定可能です。
クラス名はPascalCase、ファイル名はkebab-caseへ変換されます(例: `send-mail`はクラス`SendMail`とファイル`send-mail.ts`になります)。


### service bindingの追記

実行すると、別のWorkerからこのperformerを使う場合に呼び出し側の設定へ追記する`services`の値が出力されます。
同じWorkerで実行する分には、設定への追記は不要です。
