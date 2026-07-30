#!/usr/bin/env node
// CLIのentry, wranglerを子プロセスで呼びファイルを書くので実行はNodeに限る
// 本体は`../cli/index.js`, ここではprocessとの接続だけを行う
import { runCli } from '../cli/index.js';

process.exitCode = runCli(process.argv.slice(2));
