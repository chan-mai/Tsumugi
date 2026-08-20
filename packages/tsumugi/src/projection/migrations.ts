/**
 * マイグレーションの適用漏れの検出
 *
 * 適用は利用者の`wrangler d1 migrations apply`
 * 更新時に忘れてもデプロイは成功し、実行時に`no such column`で失敗
 * D1側のエラーだけでは原因が設定漏れと判別できず、先に検出して理由を返す
 */

/**
 * このバージョンが要求するマイグレーション
 * `migrations/`の実ファイルと一致していないと検査が無意味になり、単体テストで同期を確認
 */
export const EXPECTED_MIGRATIONS = [
	'0001_create_job_read_model.sql',
	'0002_add_attempt_log.sql',
	'0003_add_result.sql',
	'0004_create_run_read_model.sql',
	'0005_add_subflow.sql',
	'0006_add_run_after.sql',
	'0007_add_key_indexes.sql',
	'0008_add_progress.sql',
] as const;

/**
 * 検査結果
 * `missing`は適用漏れ, `unavailable`はD1の一時障害で判定できない状態(#8)
 * 両者の混同は、適用済みの環境への誤った復旧手順の案内につながる
 */
export type MigrationStatus = { ok: true } | { ok: false; missing: string[] } | { ok: false; unavailable: true };

/** 一時障害の結果を再利用する時間, 障害中の毎リクエストのD1再問い合わせを回避する短いTTL(#8) */
const UNAVAILABLE_TTL_MS = 5_000;

/** `d1_migrations`表が存在しないエラーか, これだけを「一度も適用していない」と判定(#8) */
function isMissingLedger(error: unknown): boolean {
	return error instanceof Error && /no such table/i.test(error.message) && error.message.includes('d1_migrations');
}

/**
 * 適用済みの一覧をwranglerの台帳から取得
 *
 * `d1_migrations`はwranglerが作る表でこちらの所有物ではなく、スキーマ定義を持たず生SQLで読む
 * 表自体が無い場合は一度も適用していない状態としてnullを返す
 * D1の一時障害/権限/タイムアウトは未適用と区別が必要で、上へ投げる(#8)
 */
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
		// 台帳の欠如ではない障害, 適用漏れと混同しない(#8)
		return { ok: false, unavailable: true };
	}
	if (applied === null) return { ok: false, missing: [...EXPECTED_MIGRATIONS] };

	const missing = EXPECTED_MIGRATIONS.filter((name) => !applied.includes(name));
	return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

/** 適用コマンドまで含めて返す, 読んだ人がそのまま実行可能 */
export function migrationErrorMessage(missing: readonly string[]): string {
	return `database schema is out of date: ${missing.join(', ')} not applied. run "wrangler d1 migrations apply <database> --remote"`;
}

/**
 * 検査結果をisolate単位で再利用
 * 毎リクエストのD1問い合わせを回避, 一度成功すればそのisolateが存続する間は不変
 *
 * 成功は永続でキャッシュ, 一度成功すれば適用済みは不変
 * 適用漏れはキャッシュなし, 適用後にWorkerを再デプロイせず自動で復帰
 * 一時障害は短いTTLでキャッシュ, 障害中のD1へのクエリ増加を防止(#8)
 */
export function cachedCheck(now: () => number = () => Date.now()): (db: D1Database) => Promise<MigrationStatus> {
	let settled: MigrationStatus | undefined;
	let settledAt = 0;
	let inFlight: Promise<MigrationStatus> | undefined;

	return async (db) => {
		if (settled?.ok) return settled;
		// 一時障害はTTL内だけ再利用, 経過後は再検査して復帰を反映
		if (settled && 'unavailable' in settled && now() - settledAt < UNAVAILABLE_TTL_MS) return settled;
		// 同時リクエストでの検査の重複を回避, 進行中のものを共有
		inFlight ??= checkMigrations(db).finally(() => {
			inFlight = undefined;
		});
		settled = await inFlight;
		settledAt = now();
		return settled;
	};
}
