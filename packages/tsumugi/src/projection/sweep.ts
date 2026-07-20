/**
 * 読み取りモデルの保持(ADR-0016)
 *
 * 明細とメトリクスは要求される保持期間が違う
 * 明細は個別のジョブを調べるためのもので数日あれば足り,傾向を見るための時系列はAnalytics Engine側に残る
 */
export type SweepOptions = {
	/** 終端に達したジョブをD1に残す時間,既定7日 */
	olderThanMs?: number;
	/** 1回で消す上限, 1リクエストの時間を有界にする */
	limit?: number;
};

export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_SWEEP_LIMIT = 1_000;

const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED', 'STALLED'];

/**
 * 古い終端ジョブをD1から落とす
 * 稼働中のジョブは対象にしない,実行が長引いているだけのものを消してはならない
 */
export async function sweepReadModel(db: D1Database, now: number, options: SweepOptions = {}): Promise<number> {
	const before = now - (options.olderThanMs ?? DEFAULT_RETENTION_MS);
	const limit = options.limit ?? DEFAULT_SWEEP_LIMIT;
	const placeholders = TERMINAL.map(() => '?').join(', ');

	const result = await db
		.prepare(
			`DELETE FROM job WHERE id IN (
				SELECT id FROM job WHERE state IN (${placeholders}) AND updated_at < ? LIMIT ?
			)`,
		)
		.bind(...TERMINAL, before, limit)
		.run();

	return result.meta.changes ?? 0;
}
