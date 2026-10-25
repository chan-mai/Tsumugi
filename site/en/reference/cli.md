---
title: CLI
description: The commands in the CLI included in the tsumugi package, and the options and behavior of tsumugi init and tsumugi add-performer
publishedAt: 2026-07-22
updatedAt: 2026-10-25
---

<h1 id="cli">CLI</h1>

The `tsumugi` package includes a CLI for setup.
You do not need to install it separately.
In a project where you have added the package, run `npx tsumugi`.
When you run it without arguments, it starts in interactive mode.
In environments that are not a TTY, such as pipes and CI, it does not start in interactive mode, prints the usage, and exits.

```bash
npx tsumugi
```

<h2 id="tsumugi-init">tsumugi init</h2>

Sets up Tsumugi in your project.

```bash
npx tsumugi init [--name <name>] [--format jsonc|toml]
```

`init` creates resources with `wrangler queues create <name>` and `wrangler d1 create <name>`.
If no wrangler configuration file exists, it generates a new one and writes the `database_id` that `wrangler d1 create` printed.
Next, it generates `src/index.ts`, `src/performers/`, and `.dev.vars`.
Finally, it runs `wrangler d1 migrations apply` (with `--local` and `--remote`) and `wrangler types`.

<h3 id="オプション">Options</h3>

| Option | Description |
| --- | --- |
| `--name <name>` | The name of the Worker. If omitted, it uses the `name` in an existing configuration file, the `name` in `package.json`, or the directory name, in that order |
| `--format <jsonc\|toml>` | The format of the configuration file to generate. The default is `jsonc` |

<h3 id="既存ファイルの扱い">Handling of existing files</h3>

`init` does not modify existing files.
If a wrangler configuration file (`wrangler.json`, `wrangler.jsonc`, or `wrangler.toml`) already exists, it prints the content to add in the format of that file.
Among the template files such as `src/index.ts`, it does not regenerate those that already exist.

<h2 id="tsumugi-add-performer">tsumugi add-performer</h2>

Adds a performer.

```bash
npx tsumugi add-performer <NAME>
```

`add-performer` generates a performer class in `src/performers/<name>.ts`.
It appends one export line to `src/performers/index.ts`.
The name can be in any of these formats: kebab-case, camelCase, PascalCase, or SNAKE_CASE.
The class name is converted to PascalCase, and the file name is converted to kebab-case.
For example, `send-mail` is generated as the class `SendMail` and the file `send-mail.ts`.

<h3 id="service-bindingの設定">Configuring a Service Binding</h3>

To call this performer from another Worker, add the `services` value to the caller's configuration file.
`add-performer` prints the value you need to add.
If the performer runs in the same Worker, you do not need to add it.
