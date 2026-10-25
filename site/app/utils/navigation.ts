export const sidebar: NavGroup[] = [
	{
		text: 'ガイド',
		items: [
			{ text: '概要', link: '/guide/overview' },
			{ text: 'Getting Started', link: '/guide/getting-started' },
			{ text: 'Performer', link: '/guide/performer' },
			{ text: 'ジョブの投入', link: '/guide/enqueue' },
			{ text: '実行の制御', link: '/guide/execution' },
			{ text: 'Flow', link: '/guide/flow' },
			{ text: '定期実行', link: '/guide/schedule' },
			{ text: 'ダッシュボードと認証', link: '/guide/dashboard' },
			{ text: '別Workerからの投入', link: '/guide/client' },
		],
	},
	{
		text: 'リファレンス',
		items: [
			{ text: 'REST API', link: '/reference/rest-api' },
			{ text: '設定', link: '/reference/config' },
			{ text: 'CLI', link: '/reference/cli' },
		],
	},
];

export const topNav: NavItem[] = [
	{ text: 'ガイド', link: '/guide/overview' },
	{ text: 'リファレンス', link: '/reference/rest-api' },
];

export const socialLinks: SocialLink[] = [
	{ name: 'GitHub', icon: 'github', link: 'https://github.com/chan-mai/Tsumugi' },
	{ name: 'npm', icon: 'npm', link: 'https://www.npmjs.com/package/tsumugi' },
];

export function normalizePath(path: string): string {
	return path.replace(/\.html$/, '').replace(/\/+$/, '') || '/';
}

export function surroundings(path: string): { prev?: NavItem; next?: NavItem } {
	const items = sidebar.flatMap((group) => group.items);
	const index = items.findIndex((item) => item.link === normalizePath(path));
	if (index < 0) return {};
	return { prev: items[index - 1], next: items[index + 1] };
}

export function breadcrumbs(path: string, title: string): BreadcrumbItem[] {
	const group = sidebar.find((g) => g.items.some((item) => item.link === normalizePath(path)));
	return [{ text: 'ホーム', link: '/' }, ...(group ? [{ text: group.text, link: group.items[0]!.link }] : []), { text: title }];
}
