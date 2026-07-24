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

/**
 * 検査結果
 * `missing`は適用漏れ, `unavailable`はD1の一時障害で判定できない状態(#8)
 * 両者を混同すると, 適用済みの環境に「マイグレーションを適用しろ」という誤った復旧手順を案内する
 */
export type MigrationStatus = { ok: true } | { ok: false; missing: string[] } | { ok: false; unavailable: true };

/** 一時障害の結果を使い回す時間, 障害中に毎リクエストD1を叩き直さないための短いTTL(#8) */
const UNAVAILABLE_TTL_MS = 5_000;

/** `d1_migrations`表が存在しないエラーか, これだけを「一度も適用していない」に落とす(#8) */
function isMissingLedger(error: unknown): boolean {
	return error instanceof Error && /no such table/i.test(error.message) && error.message.includes('d1_migrations');
}

/**
 * 適用済みの一覧をwranglerの台帳から引く
 *
 * `d1_migrations`はwranglerが作る表でこちらの所有物ではないため, スキーマ定義を持たず生SQLで読む
 * 表自体が無い場合は一度も適用していない状態としてnullを返す
 * D1の一時障害/権限/タイムアウトは未適用と区別するため, 上へ投げる(#8)
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

/** 適用コマンドまで含めて返す, 読んだ人がそのまま実行できるようにする */
export function migrationErrorMessage(missing: readonly string[]): string {
	return `database schema is out of date: ${missing.join(', ')} not applied. run "wrangler d1 migrations apply <database> --remote"`;
}

/**
 * 検査結果をisolate単位で使い回す
 * 毎リクエストD1を叩かない, 一度通ればそのisolateが生きている間は変わらない
 *
 * 成功は永続でキャッシュする, 一度通れば適用済みは変わらない
 * 適用漏れはキャッシュしない, 適用後にWorkerを再デプロイせず自力で復帰させる
 * 一時障害は短いTTLでキャッシュする, 障害中にD1へのクエリが最大になるのを防ぐ(#8)
 */
export function cachedCheck(now: () => number = () => Date.now()): (db: D1Database) => Promise<MigrationStatus> {
	let settled: MigrationStatus | undefined;
	let settledAt = 0;
	let inFlight: Promise<MigrationStatus> | undefined;

	return async (db) => {
		if (settled?.ok) return settled;
		// 一時障害はTTL内だけ使い回す, 過ぎたら再検査して復帰を拾う
		if (settled && 'unavailable' in settled && now() - settledAt < UNAVAILABLE_TTL_MS) return settled;
		// 同時リクエストで検査が重複しないよう, 進行中のものを共有する
		inFlight ??= checkMigrations(db).finally(() => {
			inFlight = undefined;
		});
		settled = await inFlight;
		settledAt = now();
		return settled;
	};
}
