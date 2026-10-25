import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';

export default defineNuxtConfig({
	compatibilityDate: '2026-07-01',
	modules: ['@nuxt/content', '@nuxtjs/color-mode', '@nuxt/fonts', 'nuxt-og-image'],
	site: {
		url: 'https://tsumugi.mq1.dev',
		name: 'Tsumugi Docs',
		description: 'A job management system designed for the Cloudflare stack.',
	},
	ogImage: { zeroRuntime: true },
	alias: { '#tailwindcss': fileURLToPath(new URL('./app/assets/css/main.css', import.meta.url)) },
	fonts: {
		families: [{ name: 'LINE Seed JP', provider: 'google', weights: [100, 400, 700, 800] }],
	},
	imports: { dirs: ['types'] },
	css: ['~/assets/css/main.css', '~/assets/css/shiki.css'],
	vite: { plugins: [tailwindcss()] },
	app: {
		head: {
			htmlAttrs: { lang: 'ja-JP' },
			meta: [{ name: 'theme-color', content: '#f7a1b2' }],
		},
	},
	colorMode: { classSuffix: '', storageKey: 'tsumugi-color-mode' },
	content: {
		database: { type: 'd1', bindingName: 'DB' },
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
	runtimeConfig: {
		public: {
			repo: 'https://github.com/chan-mai/Tsumugi',
		},
	},
	routeRules: {
		'/': { prerender: true },
		'/guide/**': { prerender: true },
		'/reference/**': { prerender: true },
		'/search': { prerender: false },
	},
	nitro: {
		preset: 'cloudflare-module',
		cloudflare: { deployConfig: true, nodeCompat: true },
		prerender: { autoSubfolderIndex: false, crawlLinks: true },
	},
});
