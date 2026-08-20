/**
 * 一覧の並べ替えで許可する列
 * 列名だけを持つ, drizzleの列への対応は`api/rest.ts`が付与
 * OpenAPI定義と経路の両方が読む共通定義, RESTから分離
 */
export const SORTABLE_COLUMNS = ['updated_at', 'created_at', 'binding', 'state', 'priority', 'attempts'] as const;

export type SortColumn = (typeof SORTABLE_COLUMNS)[number];

/** 不正な指定は既定へ, エラー化ではUIが停止 */
export function resolveSort(sort: string | null, order: string | null): { column: SortColumn; desc: boolean } {
	// `includes`で照合, `in`はプロトタイプ鎖まで参照し`constructor`等の拒否が不能
	const column = SORTABLE_COLUMNS.find((name) => name === sort) ?? 'updated_at';
	return { column, desc: order !== 'asc' };
}
