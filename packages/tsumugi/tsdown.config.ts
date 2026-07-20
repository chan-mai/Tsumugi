import { defineConfig } from 'tsdown';

export default defineConfig({
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
	// ダッシュボードのHTML文字列は同梱する,非公開のワークスペースパッケージなので外部化できない
	noExternal: ['@tsumugi/dashboard'],
	target: 'es2022',
});
