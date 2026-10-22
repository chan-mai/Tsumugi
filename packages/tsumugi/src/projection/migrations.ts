// 適用漏れでもデプロイは成功, 実行時の`no such column`では原因判別不可

/** 本バージョンの要求マイグレーション, `migrations/`との一致は単体テストで確認 */
export const EXPECTED_MIGRATIONS = [
	'0001_create_job_read_model.sql',
	'0002_add_attempt_log.sql',
	'0003_add_result.sql',
	'0004_create_run_read_model.sql',
	'0005_add_subflow.sql',
	'0006_add_run_after.sql',
	'0007_add_key_indexes.sql',
	'0008_add_progress.sql',
	'0009_add_expires_at.sql',
	'0010_add_job_logs.sql',
	'0011_add_cancel_requested_at.sql',
] as const;

/**
 * 検査結果, `missing`は適用漏れ, `unavailable`はD1一時障害で判定不可(#8)
 * 両者の区別は適用済み環境への誤った復旧手順案内の防止
 */
type MigrationStatus = { ok: true } | { ok: false; missing: string[] } | { ok: false; unavailable: true };

const UNAVAILABLE_TTL_MS = 5_000;

function isMissingLedger(error: unknown): boolean {
	return error instanceof Error && /no such table/i.test(error.message) && error.message.includes('d1_migrations');
}

// `d1_migrations`はwrangler所有で生SQL
async function appliedMigrations(db: D1Database): Promise<string[] | null> {
	try {
		const { results } = await db.prepare(`SELECT name FROM d1_migrations`).all<{ name: string }>();
		return results.map((row) => row.name);
	} catch (error) {
		if (isMissingLedger(error)) return null;
		throw error;
	}
}

export async function checkMigrations(db: D1Database): Promise<MigrationStatus> {
	let applied: string[] | null;
	try {
		applied = await appliedMigrations(db);
	} catch {
		return { ok: false, unavailable: true };
	}
	if (applied === null) return { ok: false, missing: [...EXPECTED_MIGRATIONS] };

	const missing = EXPECTED_MIGRATIONS.filter((name) => !applied.includes(name));
	return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

export function migrationErrorMessage(missing: readonly string[]): string {
	return `database schema is out of date: ${missing.join(', ')} not applied. run "wrangler d1 migrations apply <database> --remote"`;
}

/**
 * 検査結果のisolate単位キャッシュ
 * 成功は永続, 適用漏れは非キャッシュで再デプロイ無しに復帰
 * 一時障害は短いTTL, 障害中のD1クエリ増加防止(#8)
 */
export function cachedCheck(now: () => number = () => Date.now()): (db: D1Database) => Promise<MigrationStatus> {
	let settled: MigrationStatus | undefined;
	let settledAt = 0;
	let inFlight: Promise<MigrationStatus> | undefined;

	return async (db) => {
		if (settled?.ok) return settled;
		if (settled && 'unavailable' in settled && now() - settledAt < UNAVAILABLE_TTL_MS) return settled;
		inFlight ??= checkMigrations(db).finally(() => {
			inFlight = undefined;
		});
		settled = await inFlight;
		settledAt = now();
		return settled;
	};
}
