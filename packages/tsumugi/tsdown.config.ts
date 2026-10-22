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
		platform: 'neutral',
		// 非公開ワークスペースパッケージ
		noExternal: ['@tsumugi/dashboard', '@tsumugi/spec'],
		target: 'es2022',
	},
	{
		entry: { cli: 'src/entries/cli.ts' },
		format: ['esm'],
		fixedExtension: false,
		dts: false,
		clean: false,
		platform: 'node',
		// devDependencyのまま同梱, 利用者の依存から除外
		noExternal: ['@clack/prompts'],
		target: 'es2022',
	},
]);
