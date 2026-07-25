/**
 * ジョブ検索の対象
 * いずれもサーバ側は完全一致で絞り込む
 */
export type SearchField = 'id' | 'unique_key' | 'concurrency_key';

export const SEARCH_FIELDS: { key: SearchField; label: string }[] = [
	{ key: 'id', label: 'ID' },
	{ key: 'unique_key', label: 'Unique key' },
	{ key: 'concurrency_key', label: 'Concurrency key' },
];

/** ジョブIDの形式, 一致する場合は詳細を直接開く */
const JOB_ID = /^[A-Za-z_][A-Za-z0-9_]*#\d+:[A-Za-z0-9_-]+$/;

export function isJobId(value: string): boolean {
	return JOB_ID.test(value);
}
