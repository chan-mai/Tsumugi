export const sidebar: NavEntryGroup[] = [
	{
		key: 'guide',
		items: [
			{ key: 'overview', link: '/guide/overview' },
			{ key: 'gettingStarted', link: '/guide/getting-started' },
			{ key: 'performer', link: '/guide/performer' },
			{ key: 'enqueue', link: '/guide/enqueue' },
			{ key: 'execution', link: '/guide/execution' },
			{ key: 'flow', link: '/guide/flow' },
			{ key: 'schedule', link: '/guide/schedule' },
			{ key: 'dashboard', link: '/guide/dashboard' },
			{ key: 'client', link: '/guide/client' },
		],
	},
	{
		key: 'reference',
		items: [
			{ key: 'restApi', link: '/reference/rest-api' },
			{ key: 'config', link: '/reference/config' },
			{ key: 'cli', link: '/reference/cli' },
		],
	},
];

export const topNav: { key: NavSectionKey; link: string }[] = [
	{ key: 'guide', link: '/guide/overview' },
	{ key: 'reference', link: '/reference/rest-api' },
];

export const socialLinks: SocialLink[] = [
	{ name: 'GitHub', icon: 'github', link: 'https://github.com/chan-mai/Tsumugi' },
	{ name: 'npm', icon: 'npm', link: 'https://www.npmjs.com/package/tsumugi' },
];

export function normalizePath(path: string): string {
	return path.replace(/\.html$/, '').replace(/\/+$/, '') || '/';
}
