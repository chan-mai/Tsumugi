export type SearchSection = {
	id: string;
	title: string;
	titles: string[];
	content: string;
	level: number;
};

export type SearchScope = {
	value: 'all' | 'guide' | 'reference';
	label: string;
	prefix: string;
};

export type HighlightSegment = {
	text: string;
	hit: boolean;
};
