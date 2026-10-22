#!/usr/bin/env node
// Node限定(wrangler子プロセス起動, ファイル書き込み)
import { runCli } from '../cli/index.js';

process.exitCode = await runCli(process.argv.slice(2));
