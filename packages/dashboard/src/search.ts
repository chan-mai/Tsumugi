export type SearchField = 'id' | 'unique_key' | 'concurrency_key';

// 表示名: search.<field>
export const SEARCH_FIELDS: SearchField[] = ['id', 'unique_key', 'concurrency_key'];

const JOB_ID = /^[A-Za-z_][A-Za-z0-9_]*#\d+:[A-Za-z0-9_-]+$/;

export function isJobId(value: string): boolean {
	return JOB_ID.test(value);
}
