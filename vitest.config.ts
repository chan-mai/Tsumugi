import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const src = (path: string) => fileURLToPath(new URL(`./packages/tsumugi/src/entries/${path}`, import.meta.url));

// D1の読み取りモデルはマイグレーションで作る,テストでも本番と同じSQLを適用する
const migrations = await readD1Migrations(fileURLToPath(new URL('./packages/tsumugi/migrations', import.meta.url)));

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
				//
				// examples/basicが読む`tsumugi`をsrcへ向ける
				// distを読ませるとDOの変更にビルドが要り,忘れると古い実装をテストして緑になる
				// 公開パッケージとして正しいかはbuild/publint/attwが別途見る
				resolve: {
					alias: {
						'tsumugi/performer': src('performer.ts'),
						'tsumugi/ui': src('ui.ts'),
						tsumugi: src('index.ts'),
					},
				},
				plugins: [
					cloudflareTest({
						wrangler: { configPath: './examples/basic/wrangler.jsonc' },
						miniflare: {
							bindings: { TEST_MIGRATIONS: migrations },
							// examples/basicのservice bindingの相手,未定義ではworkerd自体が起動しない
							workers: [
								{
									name: 'tsumugi-example-remote-performer',
									modules: true,
									scriptPath: fileURLToPath(new URL('./packages/tsumugi/test/workers/mail-service.mjs', import.meta.url)),
								},
							],
						},
					}),
				],
				test: {
					name: 'workers',
					include: ['packages/*/test/workers/**/*.test.ts'],
					setupFiles: ['./packages/tsumugi/test/workers/setup.ts'],
				},
			},
		],
	},
});
