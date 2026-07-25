/**
 * 一覧の並べ替えで許す列
 * 列名だけを持つ, drizzleの列への対応は`api/rest.ts`が付ける
 * OpenAPI定義と経路の両方から読むので, RESTから切り離しておく
 */
export const SORTABLE_COLUMNS = ['updated_at', 'created_at', 'binding', 'state', 'priority', 'attempts'] as const;

export type SortColumn = (typeof SORTABLE_COLUMNS)[number];

/** 不正な指定は既定へ,エラー化するとUIが止まる */
export function resolveSort(sort: string | null, order: string | null): { column: SortColumn; desc: boolean } {
	// `includes`で照合する, `in`はプロトタイプ鎖まで見るので`constructor`等が素通りする
	const column = SORTABLE_COLUMNS.find((name) => name === sort) ?? 'updated_at';
	return { column, desc: order !== 'asc' };
}
