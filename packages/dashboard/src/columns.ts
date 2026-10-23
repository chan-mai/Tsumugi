import { useStorage } from '@vueuse/core';
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

// Binding/Statusは行識別用に固定, 表示名はcolumns.<key>
export const TOGGLEABLE = Object.keys(COLUMN) as (keyof typeof COLUMN)[];

export const visible = useStorage<Record<string, boolean>>(
	'tsumugi:columns',
	Object.fromEntries(TOGGLEABLE.map((key) => [key, true])),
	undefined,
	{ mergeDefaults: true },
);

export function toggleColumn(key: string) {
	visible.value = { ...visible.value, [key]: !visible.value[key] };
}

export const columnClass = (key: keyof typeof COLUMN) => (visible.value[key] ? COLUMN[key] : 'hidden');
