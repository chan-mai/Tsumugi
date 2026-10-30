/** DDLは`migrations/`のSQL, ここは投影と一覧の列定義 */
export const READ_MODEL_COLUMNS = {
	job: [
		'id',
		// 投影元アウトボックス連番, 古い投影での上書き防止
		'seq',
		'binding',
		'state',
		'priority',
		'attempts',
		'max_attempts',
		'concurrency_key',
		'unique_key',
		'guarantee',
		'created_at',
		'updated_at',
		'dispatched_at',
		'run_after',
		'expires_at',
		'cancel_requested_at',
		'progress',
		'payload',
		'result',
		'traceparent',
		'run_id',
		'node_id',
		'attempts_log',
		'logs',
	],
	/** Run DO横断の一覧用(ADR-0008 / ADR-0029) */
	run: [
		'id',
		'seq',
		'flow',
		'state',
		'input',
		'node_total',
		'node_done',
		'node_failed',
		'created_at',
		'updated_at',
		'parent_run_id',
		'parent_node_id',
	],
	run_node: [
		'run_id',
		'node_id',
		'seq',
		'binding',
		'state',
		'container',
		'parent',
		'origin',
		'after',
		'job_id',
		'child_run_id',
		'result',
		'error',
		'position',
		'created_at',
		'updated_at',
	],
} as const;

export type SqlValue = string | number | null;

export type ReadModelRow<Table extends keyof typeof READ_MODEL_COLUMNS> = Record<(typeof READ_MODEL_COLUMNS)[Table][number], SqlValue>;

export type Upsert = { sql: string; params: SqlValue[] };

/** `excluded.seq > seq`で古い状態の上書き防止, 再送や順序入れ替わりでも結果不変(ADR-0008) */
export function upsertOf<Table extends keyof typeof READ_MODEL_COLUMNS>(
	table: Table,
	values: ReadModelRow<Table>,
	keys: readonly (typeof READ_MODEL_COLUMNS)[Table][number][],
	immutable: readonly (typeof READ_MODEL_COLUMNS)[Table][number][],
): Upsert {
	const columns: readonly string[] = READ_MODEL_COLUMNS[table];
	const fixed: readonly string[] = [...keys, ...immutable];
	const set = columns
		.filter((column) => !fixed.includes(column))
		.map((column) => `"${column}" = excluded."${column}"`)
		.join(', ');
	return {
		sql: `INSERT INTO ${table} (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
			ON CONFLICT (${keys.join(', ')}) DO UPDATE SET ${set} WHERE excluded.seq > ${table}.seq`,
		// 旧スナップショットの欠落列はnullへ統一
		params: columns.map((column) => (values as Record<string, SqlValue | undefined>)[column] ?? null),
	};
}
