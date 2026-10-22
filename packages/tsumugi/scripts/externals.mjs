// 行頭のimport/exportと動的importのみ対象, ui.jsのHTML文字列内import誤検出防止

const FROM = /^[ \t]*(?:import|export)\b[^'"\n]*\bfrom\s*["']([^"']+)["']/gm;
const SIDE_EFFECT = /^[ \t]*import\s*["']([^"']+)["']/gm;
// プロパティ呼び出し除外
const DYNAMIC = /(?<![.\w$])import\s*\(\s*["']([^"']+)["']/g;

// 利用者バンドル対象外
const isBuiltin = (spec) => spec.startsWith('cloudflare:') || spec.startsWith('node:');

function packageOf(spec) {
	const parts = spec.split('/');
	return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

export function externalsIn(source) {
	const found = new Set();
	for (const pattern of [FROM, SIDE_EFFECT, DYNAMIC]) {
		for (const [, spec] of source.matchAll(pattern)) {
			if (spec.startsWith('.') || isBuiltin(spec)) continue;
			found.add(packageOf(spec));
		}
	}
	return found;
}
