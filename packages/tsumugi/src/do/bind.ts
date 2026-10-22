/** 1文に渡せるbinding変数の上限, 101個目でSQLITE_ERROR */
const BIND_LIMIT = 100;

/**
 * binding変数の上限に収まる件数へ分割
 * fan-outの展開やtickの投入候補は件数が実行時に確定し、1文にまとめると上限を超過するため
 */
export function chunk<T>(items: readonly T[], perItem: number): T[][] {
	const size = Math.max(1, Math.floor(BIND_LIMIT / perItem));
	const parts: T[][] = [];
	for (let i = 0; i < items.length; i += size) parts.push(items.slice(i, i + size));
	return parts;
}
