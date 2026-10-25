export type CalloutType = 'info' | 'tip' | 'warning' | 'danger';

export type CalloutProps = {
	type: CalloutType;
	title?: string;
};

export type ProseHeadingProps = {
	id?: string;
};

export type ProseLinkProps = {
	href?: string;
	target?: string;
};

export type ProseImageProps = {
	src?: string;
	alt?: string;
	width?: string | number;
	height?: string | number;
};

export type ProsePreProps = {
	code?: string;
	language?: string | null;
	filename?: string | null;
	highlights?: number[];
	meta?: string | null;
	class?: string | null;
};
