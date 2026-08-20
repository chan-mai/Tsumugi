import type { ConfigFormat } from './config-file.js';

/**
 * initとadd-performerが生成する内容(ADR-0036)
 *
 * 形は`examples/basic`と同一, 純粋な文字列関数のみを配置
 */

/** `ctx.exports`で自己参照のservice bindingを解決できる日付以降を指定 */
export const COMPATIBILITY_DATE = '2026-07-01';

const indent = (text: string, prefix: string): string =>
	text
		.split('\n')
		.map((line) => (line.length === 0 ? line : prefix + line))
		.join('\n');

/** wrangler設定の全体, 断片の前後を形式ごとの定型で包む */
export function wranglerConfigFile(name: string, fragment: string, format: ConfigFormat): string {
	if (format === 'toml') {
		return [
			`name = "${name}"`,
			'main = "src/index.ts"',
			`compatibility_date = "${COMPATIBILITY_DATE}"`,
			'',
			fragment,
			'',
			'# 任意の設定は必要になった時に追加: TSUMUGI_METRICS(メトリクス), RUN(flow), triggers(読み取りモデルの保持)',
			'',
		].join('\n');
	}
	return [
		'{',
		'  "$schema": "node_modules/wrangler/config-schema.json",',
		`  "name": "${name}",`,
		'  "main": "src/index.ts",',
		`  "compatibility_date": "${COMPATIBILITY_DATE}",`,
		`${indent(fragment, '  ')},`,
		'  // 任意の設定は必要になった時に追加: TSUMUGI_METRICS(メトリクス), RUN(flow), triggers(読み取りモデルの保持)',
		'}',
		'',
	].join('\n');
}

/** Workerの最小構成, flowを使わない形(getting-startedと同じ) */
export function indexFile(): string {
	return `import { bearerAuth, defineTsumugi } from 'tsumugi';
import { ui } from 'tsumugi/ui';
import * as performers from './performers/index.js';

// performerの解決は\`ctx.exports\`経由, トップレベルでのexportが必要(ADR-0037)
export * from './performers/index.js';

const tsumugi = defineTsumugi({
	performers,
	// secretから取得, 直書きではリポジトリとバンドルの両方に残る
	auth: bearerAuth((env: Env) => env.TSUMUGI_TOKEN, { cookie: 'tsumugi_token' }),
	ui: ui({ tokenCookie: 'tsumugi_token' }),
});

export { TsumugiJobShard } from 'tsumugi';

export default {
	...tsumugi,
	async fetch(request, env, ctx) {
		const { pathname } = new URL(request.url);
		if (pathname === '/enqueue') {
			// bindingからpayloadの型が確定, 取り違えはコンパイルエラー(ADR-0010)
			const id = await tsumugi.enqueue(env, { binding: 'Hello', payload: { name: 'world' } });
			return Response.json({ id });
		}
		// 残りはダッシュボードとREST APIへ
		return tsumugi.fetch!(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
`;
}

/** performer 1つにつき1ファイル, payloadは編集の起点になるプレースホルダ */
export function performerFile(className: string): string {
	return `import { Performer } from 'tsumugi/performer';

export class ${className} extends Performer<{ name: string }, void, {}, Env> {
	async perform(payload: { name: string }): Promise<void> {
		console.log(\`hello, \${payload.name}\`);
	}
}
`;
}

export const BARREL_HEADER = `// performerのバレル, ここに並べた名前がそのままbinding名(ADR-0037)
// 実行時の解決は\`ctx.exports\`が担当, 追加はこの1行だけ
`;

export const exportLine = (className: string, fileBase: string): string => `export { ${className} } from './${fileBase}.js';\n`;

/** ローカル開発用のトークン, 本番は`wrangler secret put`で設定 */
export function devVarsFile(): string {
	return 'TSUMUGI_TOKEN="dev-token"\n';
}
