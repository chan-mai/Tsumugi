import { ref } from 'vue';
import { formatTimestamp } from './time';

export const at = (value: number | null) => (value === null ? '' : formatTimestamp(value));

// 狭い画面での操作性確保、重要度の低い列から非表示
const COLUMN = {
	id: 'hidden lg:table-cell',
	startedAt: 'hidden xl:table-cell',
	updatedAt: 'hidden md:table-cell',
	attempts: 'hidden sm:table-cell',
	processingTime: 'hidden xl:table-cell',
};
export const HEAD = 'h-12 px-4 text-left align-middle font-medium text-muted-foreground whitespace-nowrap';

// Binding, Statusは行識別用に固定
export const TOGGLEABLE = [
	{ key: 'id', label: 'ID' },
	{ key: 'startedAt', label: 'Started at' },
	{ key: 'updatedAt', label: 'Updated at' },
	{ key: 'attempts', label: 'Attempts' },
	{ key: 'processingTime', label: 'Processing time' },
];
const VIEW_KEY = 'tsumugi:columns';

function loadVisible(): Record<string, boolean> {
	const all = Object.fromEntries(TOGGLEABLE.map((c) => [c.key, true]));
	try {
		return { ...all, ...(JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') as Record<string, boolean>) };
	} catch {
		return all;
	}
}

export const visible = ref(loadVisible());

export function toggleColumn(key: string) {
	visible.value = { ...visible.value, [key]: !visible.value[key] };
	try {
		localStorage.setItem(VIEW_KEY, JSON.stringify(visible.value));
	} catch {
		// プライベートモード等の書き込み不可, 表示自体は継続
	}
}

export const columnClass = (key: keyof typeof COLUMN) => (visible.value[key] ? COLUMN[key] : 'hidden');
