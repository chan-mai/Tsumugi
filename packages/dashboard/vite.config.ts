import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// 単一HTMLに全てインライン化する,配布物はこのHTMLを文字列として持つ(ADR-0025)
export default defineConfig({
	plugins: [vue(), tailwindcss(), viteSingleFile()],
	build: {
		// 画像やフォントもdata URIに畳む
		assetsInlineLimit: Number.MAX_SAFE_INTEGER,
		cssCodeSplit: false,
		rollupOptions: { output: { inlineDynamicImports: true } },
		target: 'es2022',
		minify: 'esbuild',
		emptyOutDir: true,
	},
	esbuild: { legalComments: 'none' },
	server: {
		// 開発時はwrangler devへ流す,インライン化はビルド時のみ
		proxy: { '/api': 'http://127.0.0.1:8787' },
	},
});
