import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// 単一HTMLへ全インライン化, 配布物はHTML文字列を保持(ADR-0025)
export default defineConfig({
	plugins: [vue(), tailwindcss(), viteSingleFile()],
	build: {
		assetsInlineLimit: Number.MAX_SAFE_INTEGER,
		cssCodeSplit: false,
		rollupOptions: { output: { inlineDynamicImports: true } },
		target: 'es2022',
		minify: 'esbuild',
		emptyOutDir: true,
	},
	esbuild: { legalComments: 'none' },
	server: {
		proxy: { '/api': 'http://127.0.0.1:8787' },
	},
});
