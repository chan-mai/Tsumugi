import type { SqlValue } from '../projection/columns.js';

/** SQL断片と束縛値, 列名は呼び出し側の固定値のみ */
export type Condition = { sql: string; params: SqlValue[] };

export const condition = (sql: string, ...params: SqlValue[]): Condition => ({ sql, params });

// 空配列は常に偽
export function inList(column: string, values: readonly SqlValue[]): Condition {
	if (values.length === 0) return condition('0');
	return condition(`${column} IN (${values.map(() => '?').join(', ')})`, ...values);
}

// 空配列は常に真
export function notInList(column: string, values: readonly SqlValue[]): Condition {
	if (values.length === 0) return condition('1');
	return condition(`${column} NOT IN (${values.map(() => '?').join(', ')})`, ...values);
}

export function and(...conditions: (Condition | undefined)[]): Condition | undefined {
	const present = conditions.filter((c) => c !== undefined);
	if (present.length === 0) return undefined;
	return { sql: present.map((c) => `(${c.sql})`).join(' AND '), params: present.flatMap((c) => c.params) };
}

export function or(...conditions: (Condition | undefined)[]): Condition | undefined {
	const present = conditions.filter((c) => c !== undefined);
	if (present.length === 0) return undefined;
	return { sql: present.map((c) => `(${c.sql})`).join(' OR '), params: present.flatMap((c) => c.params) };
}

export function whereOf(clause: Condition | undefined): Condition {
	return clause ? { sql: ` WHERE ${clause.sql}`, params: clause.params } : { sql: '', params: [] };
}
