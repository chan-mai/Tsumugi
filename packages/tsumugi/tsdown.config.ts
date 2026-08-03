import { defineConfig } from 'tsdown';

export default defineConfig([
	{
		entry: {
			index: 'src/entries/index.ts',
			performer: 'src/entries/performer.ts',
			client: 'src/entries/client.ts',
			ui: 'src/entries/ui.ts',
			types: 'src/entries/types.ts',
			testing: 'src/entries/testing.ts',
		},
		format: ['esm'],
		dts: true,
		clean: true,
		// Workers向けなのでNode向けのshimは入れない
		platform: 'neutral',
		// ダッシュボードのHTMLとOpenAPI文書は同梱する,非公開のワークスペースパッケージなので外部化できない
		noExternal: ['@tsumugi/dashboard', '@tsumugi/spec'],
		target: 'es2022',
	},
	{
		// CLIはNodeで動くのでWorkers向けとconfigを分ける(ADR-0036)
		entry: { cli: 'src/entries/cli.ts' },
		format: ['esm'],
		// type: moduleなので.jsのままESMになる, 他のentryと拡張子を揃える
		fixedExtension: false,
		dts: false,
		// trueにすると1つ目のconfigの出力を消す
		clean: false,
		platform: 'node',
		// 対話モードの@clack/promptsはdevDependencyのまま同梱し, 利用者の依存に乗せない
		noExternal: ['@clack/prompts'],
		target: 'es2022',
	},
]);
