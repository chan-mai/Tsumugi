// 1文のbinding変数上限, 101個目でSQLITE_ERROR
const BIND_LIMIT = 100;

export function chunk<T>(items: readonly T[], perItem: number): T[][] {
	const size = Math.max(1, Math.floor(BIND_LIMIT / perItem));
	const parts: T[][] = [];
	for (let i = 0; i < items.length; i += size) parts.push(items.slice(i, i + size));
	return parts;
}

export const placeholders = (count: number) => Array.from({ length: count }, () => '?').join(', ');

// 予約語の列名(after, trigger等)対策
export const columnList = (columns: readonly string[]) => columns.map((column) => `"${column}"`).join(', ');

// 列名は呼び出し側の固定値のみ
export const assignments = (set: Record<string, SqlStorageValue>) =>
	Object.keys(set)
		.map((column) => `${column} = ?`)
		.join(', ');

// 列名で値を対応, 列順変更時の取り違え防止
export const valuesOf = <Column extends string>(columns: readonly Column[], row: Record<Column, SqlStorageValue>) =>
	columns.map((column) => row[column]);
