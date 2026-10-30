import { externalsIn } from './externals.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { gzipSync } from 'node:zlib';

const BUDGETS = {
	'dist/ui.js': 400 * 1024,
	'dist/index.js': 100 * 1024,
	'dist/performer.js': 16 * 1024,
	'dist/client.js': 16 * 1024,
	'dist/testing.js': 16 * 1024,
	// @clack/prompts同梱分を加算
	'dist/cli.js': 32 * 1024,
};

const FORBIDDEN = {
	'dist/client.js': [/extends DurableObject/, /CREATE TABLE/],
	'dist/performer.js': [/extends DurableObject/, /CREATE TABLE/],
	'dist/testing.js': [/extends DurableObject/, /CREATE TABLE/],
	'dist/cli.js': [/extends DurableObject/],
};

const CANARY = { 'dist/index.js': [/extends DurableObject/, /CREATE TABLE/] };

const IMPORT = /(?:from|import)\s*["'](\.[^"']+)["']/g;

// 外部依存はgzip量に非反映で集合検査
const ALLOWED_EXTERNALS = {
	'dist/ui.js': [],
	'dist/index.js': [],
	'dist/performer.js': [],
	'dist/client.js': [],
	'dist/testing.js': [],
	// @clack/prompts外部化漏れの検出対象
	// 'tsumugi'は雛形テンプレート文字列内のimport行
	'dist/cli.js': ['tsumugi'],
};

function externalsOf(files) {
	const found = new Set();
	for (const path of files) for (const spec of externalsIn(readFileSync(path, 'utf8'))) found.add(spec);
	return [...found].sort();
}

function closureOf(entry) {
	const seen = new Set();
	const stack = [normalize(entry)];
	while (stack.length > 0) {
		const path = stack.pop();
		if (seen.has(path)) continue;
		let source;
		try {
			source = readFileSync(path, 'utf8');
		} catch {
			continue;
		}
		seen.add(path);
		for (const [, spec] of source.matchAll(IMPORT)) stack.push(normalize(join(dirname(path), spec)));
	}
	return [...seen].sort();
}

const fmt = (n) => `${(n / 1024).toFixed(1)}KB`;

let failed = false;
for (const [path, budget] of Object.entries(BUDGETS)) {
	const files = closureOf(path);
	if (files.length === 0) {
		console.error(`✗ ${path} not found (build first)`);
		failed = true;
		continue;
	}

	const source = files.map((f) => readFileSync(f, 'utf8')).join('\n');
	const size = gzipSync(Buffer.from(source)).length;
	const pct = Math.round((size / budget) * 100);
	const externals = externalsOf(files);
	const deps = externals.length > 0 ? `, external: ${externals.join(' ')}` : '';

	if (size > budget) {
		console.error(`✗ ${path} ${fmt(size)}/budget ${fmt(budget)} (${pct}%) [${files.length} files${deps}]`);
		failed = true;
	} else {
		console.log(`✓ ${path} ${fmt(size)}/budget ${fmt(budget)} (${pct}%) [${files.length} files${deps}]`);
	}

	const allowed = ALLOWED_EXTERNALS[path] ?? [];
	for (const dep of externals) {
		if (!allowed.includes(dep)) {
			console.error(`  ✗ undeclared external dependency: ${dep}`);
			failed = true;
		}
	}

	for (const pattern of FORBIDDEN[path] ?? []) {
		if (pattern.test(source)) {
			console.error(`  ✗ found an implementation that must not be bundled: ${pattern}`);
			failed = true;
		}
	}

	for (const pattern of CANARY[path] ?? []) {
		if (!pattern.test(source)) {
			console.error(`  ✗ marker not found, the isolation check is no longer meaningful: ${pattern}`);
			failed = true;
		}
	}
}

process.exit(failed ? 1 : 0);
