// ダッシュボードをJSに焼き込む以上(ADR-0025),無警戒ではバンドルが膨らむ
// 中身が空のM0時点から検査を入れておく,実装後に初めて測ると太った後で削る羽目になる
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { gzipSync } from 'node:zlib';

/** entry -> gzip後の上限バイト数 */
const BUDGETS = {
	'dist/ui.js': 400 * 1024,
	'dist/index.js': 100 * 1024,
	'dist/performer.js': 16 * 1024,
	'dist/client.js': 16 * 1024,
};

/**
 * 取り込んではならない実体
 * サブパス分割の意味はサイズだけでなく依存の遮断,予算内でも混入は失敗扱い
 */
const FORBIDDEN = {
	'dist/client.js': [/extends DurableObject/, /CREATE TABLE/],
	'dist/performer.js': [/extends DurableObject/, /CREATE TABLE/],
};

/** 印の実在確認,常に当たらないパターンは検査の形骸化 */
const CANARY = { 'dist/index.js': [/extends DurableObject/, /CREATE TABLE/] };

const IMPORT = /(?:from|import)\s*["'](\.[^"']+)["']/g;
const BARE_IMPORT = /(?:from|import)\s*["']([^."'][^"']*)["']/g;

/**
 * entryごとに載ってよい外部依存
 * 外部依存はバンドルされずimport文として残るためgzip量に現れない
 * 量ではなく集合で見る, 増えた時に気づけることが目的
 */
const ALLOWED_EXTERNALS = {
	'dist/ui.js': [],
	'dist/index.js': ['@paralleldrive/cuid2', 'drizzle-orm', 'hono'],
	'dist/performer.js': [],
	'dist/client.js': [],
};

/** import文に残る外部依存をパッケージ名の集合で返す, workerdの組み込みは利用者のバンドルに載らないので除く */
function externalsOf(files) {
	const found = new Set();
	for (const path of files) {
		for (const [, spec] of readFileSync(path, 'utf8').matchAll(BARE_IMPORT)) {
			if (spec.startsWith('cloudflare:') || spec.startsWith('node:')) continue;
			const parts = spec.split('/');
			found.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
		}
	}
	return [...found].sort();
}

/**
 * entryが読み込むファイルの再帰的な収集
 * tsdownは共有チャンクへ切り出すため, entry単体では再エクスポート行しか見えない
 */
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
		console.error(`✗ ${path}が見つからない(先にbuildが必要)`);
		failed = true;
		continue;
	}

	const source = files.map((f) => readFileSync(f, 'utf8')).join('\n');
	const size = gzipSync(Buffer.from(source)).length;
	const pct = Math.round((size / budget) * 100);
	const externals = externalsOf(files);
	const deps = externals.length > 0 ? `, 外部: ${externals.join(' ')}` : '';

	if (size > budget) {
		console.error(`✗ ${path} ${fmt(size)}/予算${fmt(budget)} (${pct}%) [${files.length}ファイル${deps}]`);
		failed = true;
	} else {
		console.log(`✓ ${path} ${fmt(size)}/予算${fmt(budget)} (${pct}%) [${files.length}ファイル${deps}]`);
	}

	const allowed = ALLOWED_EXTERNALS[path] ?? [];
	for (const dep of externals) {
		if (!allowed.includes(dep)) {
			console.error(`  ✗ 宣言していない外部依存: ${dep}`);
			failed = true;
		}
	}

	for (const pattern of FORBIDDEN[path] ?? []) {
		if (pattern.test(source)) {
			console.error(`  ✗ 取り込まれてはならない実体がある: ${pattern}`);
			failed = true;
		}
	}

	for (const pattern of CANARY[path] ?? []) {
		if (!pattern.test(source)) {
			console.error(`  ✗ 印が見つからない,遮断の検査が形骸化している: ${pattern}`);
			failed = true;
		}
	}
}

process.exit(failed ? 1 : 0);
