/**
 * ビルド成果物に残る外部依存の検出
 *
 * dist/ui.jsはダッシュボードのHTMLを文字列で持つので, 文中の`import '...'`をimport文と読み違えない
 * 宣言の形に限る, 行頭のimport/exportと括弧付きの動的importだけを見る
 */

/** import文とexport文の`from`, 行頭に限る */
const FROM = /^[ \t]*(?:import|export)\b[^'"\n]*\bfrom\s*["']([^"']+)["']/gm;
/** 副作用のimport, 行頭に限る */
const SIDE_EFFECT = /^[ \t]*import\s*["']([^"']+)["']/gm;
/** 動的import, プロパティ呼び出しは除く */
const DYNAMIC = /(?<![.\w$])import\s*\(\s*["']([^"']+)["']/g;

/** 利用者のバンドルに載らない指定 */
const isBuiltin = (spec) => spec.startsWith('cloudflare:') || spec.startsWith('node:');

/** パッケージ名へ丸める, サブパスは落とす */
function packageOf(spec) {
	const parts = spec.split('/');
	return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** ソースに残る外部依存をパッケージ名の集合で返す, 相対指定は含めない */
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
