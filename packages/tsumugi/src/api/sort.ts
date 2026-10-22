// OpenAPI定義, REST共通参照用に列名のみ分離
export const SORTABLE_COLUMNS = ['updated_at', 'created_at', 'binding', 'state', 'priority', 'attempts'] as const;

export type SortColumn = (typeof SORTABLE_COLUMNS)[number];

/** 不正指定は既定値へ, エラー時のUI停止回避 */
export function resolveSort(sort: string | null, order: string | null): { column: SortColumn; desc: boolean } {
	// 配列で照合, `in`はプロトタイプチェーン参照で`constructor`等も一致
	const column = SORTABLE_COLUMNS.find((name) => name === sort) ?? 'updated_at';
	return { column, desc: order !== 'asc' };
}
