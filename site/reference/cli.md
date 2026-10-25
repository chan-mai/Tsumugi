---
title: CLI
description: tsumugiパッケージに含まれるCLIのコマンド, tsumugi initとtsumugi add-performerのオプションと動作について
publishedAt: 2026-07-22
updatedAt: 2026-10-25
---

# CLI

`tsumugi`パッケージは、セットアップ用のCLIを含みます。
別途インストールする必要はありません。
パッケージを追加したプロジェクトで、`npx tsumugi`を実行します。
引数なしで実行すると、対話モードで起動します。
パイプやCIなどTTYでない環境では、対話モードにならず、使用方法を出力して終了します。

```bash
npx tsumugi
```

## tsumugi init

プロジェクトにTsumugiをセットアップします。

```bash
npx tsumugi init [--name <name>] [--format jsonc|toml]
```

`init`は、`wrangler queues create <name>`と`wrangler d1 create <name>`でリソースを作成します。
wranglerの設定ファイルが存在しない場合、新たに生成し、`wrangler d1 create`が出力した`database_id`を書き込みます。
次に、`src/index.ts`, `src/performers/`, `.dev.vars`を生成します。
最後に、`wrangler d1 migrations apply`(`--local`と`--remote`)と`wrangler types`を実行します。

### オプション

| オプション | 内容 |
| --- | --- |
| `--name <name>` | Workerの名前。省略した場合は、既存の設定ファイルの`name`, `package.json`の`name`, ディレクトリ名の順に使用 |
| `--format <jsonc\|toml>` | 生成する設定ファイルの形式。既定は`jsonc` |

### 既存ファイルの扱い

`init`は、既存のファイルを変更しません。
wranglerの設定ファイル(`wrangler.json`, `wrangler.jsonc`, `wrangler.toml`)が既に存在する場合は、追記する内容をそのファイルの形式で出力します。
`src/index.ts`などの雛形のうち、既存のファイルは再生成しません。

## tsumugi add-performer

performerを追加します。

```bash
npx tsumugi add-performer <NAME>
```

`add-performer`は、`src/performers/<name>.ts`にperformerのクラスを生成します。
`src/performers/index.ts`には、export行を1行追記します。
名前は、kebab-case, camelCase, PascalCase, SNAKE_CASEのいずれの形式も受け付けます。
クラス名はPascalCaseに、ファイル名はkebab-caseに変換します。
たとえば`send-mail`は、クラス`SendMail`とファイル`send-mail.ts`として生成されます。

### Service Bindingの設定

別のWorkerからこのperformerを呼び出す場合は、呼び出し側の設定ファイルに`services`の値を追加してください。
`add-performer`は、追加すべき値を出力します。
同じWorker内でperformerを実行する場合は、追加は不要です。
