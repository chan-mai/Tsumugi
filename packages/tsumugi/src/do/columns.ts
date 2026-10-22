// CREATE TABLE IF NOT EXISTSは既存テーブル不変
export function ensureColumns(sql: SqlStorage, table: string, columns: readonly (readonly [name: string, type: string])[]): Set<string> {
	const existing = new Set(
		sql
			.exec<{ name: string }>(`SELECT name FROM pragma_table_info(?)`, table)
			.toArray()
			.map((row) => row.name),
	);
	const added = new Set<string>();
	for (const [name, type] of columns) {
		if (existing.has(name)) continue;
		sql.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
		added.add(name);
	}
	return added;
}
