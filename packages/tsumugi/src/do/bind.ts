// 1文のbinding変数上限, 101個目でSQLITE_ERROR
const BIND_LIMIT = 100;

export function chunk<T>(items: readonly T[], perItem: number): T[][] {
	const size = Math.max(1, Math.floor(BIND_LIMIT / perItem));
	const parts: T[][] = [];
	for (let i = 0; i < items.length; i += size) parts.push(items.slice(i, i + size));
	return parts;
}
