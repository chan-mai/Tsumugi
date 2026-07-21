import { defineConfig } from 'vitepress';

const repo = 'https://github.com/chan-mai/Tsumugi';
const year = new Date().getFullYear();
const copyright = `Copyright © ${Number(year) > 2026 ? `2026-${year}` : year} chan-mai All Rights Reserved.`;

export default defineConfig({
	lang: 'ja-JP',
	title: 'Tsumugi',
	description: 'Cloudflareスタック向けに設計されたジョブ管理システム',
	cleanUrls: true,
	lastUpdated: true,
	head: [['meta', { name: 'theme-color', content: '#f7a1b2' }]],
	themeConfig: {
		nav: [
			{ text: 'ガイド', link: '/guide/overview' },
			{ text: 'リファレンス', link: '/reference/rest-api' },
		],
		sidebar: [
			{
				text: 'ガイド',
				items: [
					{ text: '概要', link: '/guide/overview' },
					{ text: 'Getting Started', link: '/guide/getting-started' },
					{ text: 'Performer', link: '/guide/performer' },
					{ text: 'ジョブの投入', link: '/guide/enqueue' },
					{ text: '実行の制御', link: '/guide/execution' },
					{ text: 'ダッシュボードと認証', link: '/guide/dashboard' },
					{ text: '別Workerからの投入', link: '/guide/client' },
				],
			},
			{
				text: 'リファレンス',
				items: [
					{ text: 'REST API', link: '/reference/rest-api' },
					{ text: '設定', link: '/reference/config' },
				],
			},
		],
		socialLinks: [{ icon: 'github', link: repo }],
		editLink: {
			pattern: `${repo}/edit/main/site/:path`,
			text: 'このページを編集',
		},
		docFooter: { prev: '前のページ', next: '次のページ' },
		outline: { level: [2, 3], label: 'このページの内容' },
		lastUpdatedText: '最終更新',
		darkModeSwitchLabel: '外観',
		returnToTopLabel: 'トップへ',
		sidebarMenuLabel: 'メニュー',
		search: { provider: 'local' },
		footer: {
			copyright: copyright,
		},
	},
});
