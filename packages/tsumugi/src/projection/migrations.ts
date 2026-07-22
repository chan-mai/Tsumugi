/**
 * マイグレーションの適用漏れを検出する
 *
 * 利用者は`wrangler d1 migrations apply`を自分で走らせる
 * 更新時に忘れるとデプロイは通り, 実行時に`no such column`で落ちる
 * D1側のエラーがそのまま出ても原因が設定漏れだと分からないので, 先に検出して理由を返す
 */

/**
 * このバージョンが要求するマイグレーション
 * `migrations/`の実ファイルと一致していないと検査が無意味になるので, 単体テストで突き合わせる
 */
export const EXPECTED_MIGRATIONS = ['0001_create_job_read_model.sql', '0002_add_attempt_log.sql', '0003_add_result.sql'] as const;

export type MigrationStatus = { ok: true } | { ok: false; missing: string[] };

/**
 * 適用済みの一覧をwranglerの台帳から引く
 *
 * `d1_migrations`はwranglerが作る表でこちらの所有物ではないため, スキーマ定義を持たず生SQLで読む
 * 表自体が無い場合は一度も適用していない状態, 例外を握って全件未適用として扱う
 */
async function appliedMigrations(db: D1Database): Promise<string[] | null> {
	try {
		const { results } = await db.prepare(`SELECT name FROM d1_migrations`).all<{ name: string }>();
		return results.map((row) => row.name);
	} catch {
		return null;
	}
}

export async function checkMigrations(db: D1Database): Promise<MigrationStatus> {
	const applied = await appliedMigrations(db);
	if (applied === null) return { ok: false, missing: [...EXPECTED_MIGRATIONS] };

	const missing = EXPECTED_MIGRATIONS.filter((name) => !applied.includes(name));
	return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

/** 適用コマンドまで含めて返す, 読んだ人がそのまま実行できるようにする */
export function migrationErrorMessage(missing: readonly string[]): string {
	return `database schema is out of date: ${missing.join(', ')} not applied. run "wrangler d1 migrations apply <database> --remote"`;
}

/**
 * 検査結果をisolate単位で使い回す
 * 毎リクエストD1を叩かない, 一度通ればそのisolateが生きている間は変わらない
 */
export function cachedCheck(): (db: D1Database) => Promise<MigrationStatus> {
	let settled: MigrationStatus | undefined;
	let inFlight: Promise<MigrationStatus> | undefined;

	return async (db) => {
		if (settled?.ok) return settled;
		// 同時リクエストで検査が重複しないよう, 進行中のものを共有する
		inFlight ??= checkMigrations(db).finally(() => {
			inFlight = undefined;
		});
		settled = await inFlight;
		return settled;
	};
}
