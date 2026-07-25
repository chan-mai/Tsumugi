import { describe, expect, it } from 'vitest';
// @ts-expect-error 検査スクリプトと同じ実装を見るため型定義のないmjsを直接読む
import { externalsIn } from '../../scripts/externals.mjs';

/**
 * バンドルに残る外部依存の検出
 *
 * 誤検出はリリース前の検査を落とすので, import文の形に限ることを固定する
 */

const scan = (source: string) => [...(externalsIn(source) as Set<string>)].sort();

describe('外部依存の検出', () => {
	it('import文とexport文を拾う', () => {
		expect(scan(`import { a } from "hono";`)).toEqual(['hono']);
		expect(scan(`import "side-effect";`)).toEqual(['side-effect']);
		expect(scan(`export { b } from 'drizzle-orm';`)).toEqual(['drizzle-orm']);
		expect(scan(`const m = await import("lazy-dep");`)).toEqual(['lazy-dep']);
	});

	it('サブパスはパッケージ名へ丸める', () => {
		expect(scan(`import x from "@scope/pkg/sub/path";`)).toEqual(['@scope/pkg']);
		expect(scan(`import y from "pkg/sub";`)).toEqual(['pkg']);
	});

	it('相対指定と組み込みは外部依存にしない', () => {
		expect(scan(`import a from "./local.js";\nimport b from "node:fs";\nimport c from "cloudflare:workers";`)).toEqual([]);
	});

	it('文字列やコメントの中の文言を拾わない', () => {
		// ダッシュボードのHTMLに焼き込まれる案内文がこの形をしている
		expect(scan(`const msg = "Please import '@vue-flow/core/dist/style.css' to render";`)).toEqual([]);
		expect(scan(`// import 'docs-only-example';`)).toEqual([]);
		expect(scan(`const text = \`import "in-template"\`;`)).toEqual([]);
	});

	it('プロパティ呼び出しのimportを拾わない', () => {
		expect(scan(`loader.import("not-a-dep");`)).toEqual([]);
	});
});
