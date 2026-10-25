import tailwindcss from '@tailwindcss/vite';

const repo = 'https://github.com/chan-mai/Tsumugi';

export default defineNuxtConfig({
	compatibilityDate: '2026-07-01',
	modules: ['@nuxt/content', '@nuxtjs/color-mode', '@nuxt/fonts'],
	fonts: {
		families: [{ name: 'LINE Seed JP', provider: 'google', weights: [100, 400, 700, 800] }],
	},
	imports: { dirs: ['types'] },
	css: ['~/assets/css/main.css', '~/assets/css/shiki.css'],
	vite: { plugins: [tailwindcss()] },
	app: {
		head: {
			htmlAttrs: { lang: 'ja-JP' },
			meta: [
				{ name: 'description', content: 'Cloudflare Workers向けに設計されたジョブマネジメントシステム' },
				{ name: 'theme-color', content: '#f7a1b2' },
			],
		},
	},
	colorMode: { classSuffix: '', storageKey: 'tsumugi-color-mode' },
	content: {
		experimental: { sqliteConnector: 'native' },
		build: {
			markdown: {
				remarkPlugins: { 'remark-breaks': {} },
				toc: { depth: 3, searchDepth: 3 },
				highlight: {
					theme: { default: 'github-light', dark: 'github-dark' },
					langs: ['ts', 'bash', 'json', 'jsonc'],
				},
			},
		},
	},
	runtimeConfig: { public: { repo } },
	nitro: {
		prerender: { autoSubfolderIndex: false, crawlLinks: true, routes: ['/'] },
	},
});
