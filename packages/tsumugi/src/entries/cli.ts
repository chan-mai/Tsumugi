#!/usr/bin/env node
// CLIのentry, wranglerの子プロセス起動とファイル書き込みがあり実行はNodeに限定
// 本体は`../cli/index.js`, ここはprocessとの接続のみ
import { runCli } from '../cli/index.js';

process.exitCode = await runCli(process.argv.slice(2));
