// 各コンポーネント共通のクラス

const BUTTON_BASE =
	'inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-strong disabled:cursor-not-allowed';

const VARIANT = {
	primary: 'border-none bg-accent text-on-accent hover:bg-accent-hover disabled:bg-neutral-soft disabled:text-ink-subtle',
	secondary: 'border border-line-strong bg-surface text-ink hover:bg-canvas disabled:text-ink-subtle',
	danger: 'border-none bg-critical text-white hover:bg-critical-hover disabled:bg-neutral-soft disabled:text-ink-subtle',
	ghost: 'border-none bg-transparent text-ink-muted hover:bg-neutral-soft hover:text-ink disabled:text-ink-subtle',
} as const;

const SIZE = { sm: 'h-8 px-2.5 text-xs', md: 'h-9 px-3.5 text-sm' } as const;

export const button = (variant: keyof typeof VARIANT, size: keyof typeof SIZE = 'md') => `${BUTTON_BASE} ${VARIANT[variant]} ${SIZE[size]}`;

export const TABLE_WRAP = 'relative w-full overflow-x-auto rounded-2xl border border-line bg-surface';
export const TABLE = 'w-full text-sm';
export const THEAD = 'bg-canvas';
export const TH = 'h-11 px-4 text-left align-middle text-xs font-semibold tracking-wide whitespace-nowrap text-ink-muted';
export const TBODY = 'divide-y divide-line';
export const TD = 'px-4 py-3 align-middle whitespace-nowrap';
export const EMPTY_ROW = 'h-24 text-center text-ink-subtle';

export const INPUT =
	'block h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink outline-none placeholder:text-ink-subtle focus:border-accent-strong';
export const LABEL = 'mb-1 block text-sm font-medium text-ink';

// ツールバーのメニューボタン
export const CHIP =
	'flex h-9 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink transition-colors hover:bg-canvas';
export const CHIP_DASHED =
	'flex h-9 items-center gap-1.5 rounded-lg border border-dashed border-line-strong bg-surface px-3 text-sm text-ink transition-colors hover:bg-canvas';
export const CHIP_VALUE = 'ml-1 rounded-full bg-accent-soft px-2 text-xs text-accent-strong';

export const MENU_PANEL = 'absolute z-20 mt-1 rounded-xl border border-line bg-surface p-1 text-sm focus:outline-none';
export const MENU_ITEM = 'flex w-full items-center gap-2 rounded-lg border-none bg-transparent px-2 py-1.5 text-left text-sm text-ink';
export const MENU_ITEM_HOVER = 'hover:bg-accent-soft hover:text-accent-strong';
export const MENU_CAPTION = 'px-2 py-1.5 text-xs text-ink-subtle';

export const CARD = 'rounded-2xl border border-line bg-surface p-6';
export const CODE = 'overflow-auto rounded-xl bg-canvas p-3 font-mono text-xs';
export const LINK =
	'border-none bg-transparent p-0 font-mono text-xs break-all text-accent-strong underline underline-offset-2 hover:text-ink';
export const ERROR_TEXT = 'text-sm text-critical';
export const MUTED_TEXT = 'text-sm text-ink-muted';
