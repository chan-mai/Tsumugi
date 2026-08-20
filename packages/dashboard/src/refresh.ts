/**
 * 一覧を取り直す間隔
 * 0は自動更新なし
 */
export const REFRESH_OPTIONS = [
	{ ms: 0, label: 'Off' },
	{ ms: 1_000, label: '1s' },
	{ ms: 3_000, label: '3s' },
	{ ms: 10_000, label: '10s' },
	{ ms: 30_000, label: '30s' },
	{ ms: 60_000, label: '1m' },
] as const;

/** 投影は数秒の遅延, 既定はそれに合わせた値 */
export const DEFAULT_REFRESH_MS = 3_000;

export const REFRESH_KEY = 'tsumugi:refresh';

/** 保存した間隔を読む, 選択肢に無い値は既定を使用 */
export function loadRefresh(storage: Pick<Storage, 'getItem'>): number {
	const raw = storage.getItem(REFRESH_KEY);
	// 未設定の数値化は0になり、自動更新なしと区別が不能
	if (raw === null || raw === '') return DEFAULT_REFRESH_MS;
	const ms = Number(raw);
	return REFRESH_OPTIONS.some((option) => option.ms === ms) ? ms : DEFAULT_REFRESH_MS;
}
