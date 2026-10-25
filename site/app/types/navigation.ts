export type NavPageKey =
	| 'overview'
	| 'gettingStarted'
	| 'performer'
	| 'enqueue'
	| 'execution'
	| 'flow'
	| 'schedule'
	| 'dashboard'
	| 'client'
	| 'restApi'
	| 'config'
	| 'cli';

export type NavSectionKey = 'guide' | 'reference';

export type NavEntry = {
	key: NavPageKey;
	link: string;
};

export type NavEntryGroup = {
	key: NavSectionKey;
	items: NavEntry[];
};

export type NavItem = {
	text: string;
	link: string;
};

export type NavGroup = {
	text: string;
	items: NavItem[];
};

export type SocialLink = {
	name: string;
	icon: IconName;
	link: string;
};

export type TocLink = {
	id: string;
	text: string;
	depth: number;
	children?: TocLink[];
};

export type BreadcrumbItem = {
	text: string;
	link?: string;
};
