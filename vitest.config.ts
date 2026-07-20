import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		projects: [
			{
				// coreの純粋関数, workerdを起動しないので数百msで終わる(保存時に回す用)
				test: {
					name: 'unit',
					environment: 'node',
					include: ['packages/*/test/unit/**/*.test.ts'],
				},
			},
			{
				// workerdを起動する統合テスト,純粋関数では分からないことだけを対象にする
				plugins: [cloudflareTest({ wrangler: { configPath: './examples/basic/wrangler.jsonc' } })],
				test: {
					name: 'workers',
					include: ['packages/*/test/workers/**/*.test.ts'],
				},
			},
		],
	},
});
