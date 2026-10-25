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
