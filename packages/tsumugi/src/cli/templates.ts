import type { ConfigFormat } from './config-file.js';

// 形式は`examples/basic`と同一(ADR-0036)

/** `ctx.exports`で自己参照service binding解決可能な日付以降 */
const COMPATIBILITY_DATE = '2026-07-01';

const indent = (text: string, prefix: string): string =>
	text
		.split('\n')
		.map((line) => (line.length === 0 ? line : prefix + line))
		.join('\n');

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

/** getting-startedと同一内容 */
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

export function devVarsFile(): string {
	return 'TSUMUGI_TOKEN="dev-token"\n';
}
