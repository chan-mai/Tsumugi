// ダッシュボードをJSに焼き込む以上(ADR-0025), 無警戒だとバンドルが膨らむ
// 中身が空のM0時点から検査を入れておく, 実装後に初めて測ると太った後で削る羽目になる
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

/** entry -> gzip後の上限バイト数 */
const BUDGETS = {
	'dist/ui.js': 400 * 1024,
	'dist/index.js': 100 * 1024,
	'dist/performer.js': 16 * 1024,
	'dist/client.js': 16 * 1024,
};

const fmt = (n) => `${(n / 1024).toFixed(1)}KB`;

let failed = false;
for (const [path, budget] of Object.entries(BUDGETS)) {
	let size;
	try {
		size = gzipSync(readFileSync(path)).length;
	} catch {
		console.error(`✗ ${path} が見つからない(先に build が必要)`);
		failed = true;
		continue;
	}
	const pct = Math.round((size / budget) * 100);
	if (size > budget) {
		console.error(`✗ ${path} ${fmt(size)} / 予算 ${fmt(budget)} (${pct}%)`);
		failed = true;
	} else {
		console.log(`✓ ${path} ${fmt(size)} / 予算 ${fmt(budget)} (${pct}%)`);
	}
}

process.exit(failed ? 1 : 0);
