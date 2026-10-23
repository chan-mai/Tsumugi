import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// 単一HTMLへ全インライン化, 配布物はHTML文字列を保持(ADR-0025)
export default defineConfig({
	plugins: [
		vue(),
		tailwindcss(),
		viteSingleFile(),
		// 開発サーバのみ
		{
			name: 'tsumugi-dev-config',
			apply: 'serve',
			transformIndexHtml: () => [
				{
					tag: 'script',
					children: `window.__TSUMUGI__=${JSON.stringify({ tokenCookie: process.env.TSUMUGI_TOKEN_COOKIE ?? 'tsumugi_token' })}`,
					injectTo: 'head-prepend',
				},
			],
		},
	],
	build: {
		assetsInlineLimit: Number.MAX_SAFE_INTEGER,
		cssCodeSplit: false,
		rollupOptions: { output: { inlineDynamicImports: true } },
		target: 'es2022',
		minify: 'esbuild',
		emptyOutDir: true,
	},
	esbuild: { legalComments: 'none' },
	// vue-i18nの未使用機能除外
	define: {
		__VUE_I18N_FULL_INSTALL__: false,
		__VUE_I18N_LEGACY_API__: false,
		__INTLIFY_PROD_DEVTOOLS__: false,
	},
	server: {
		proxy: { '/api': `http://127.0.0.1:${process.env.TSUMUGI_DEV_PORT ?? 8787}` },
	},
});
