/**
 * 注入可能な時計
 *
 * Workersに時間を進めるAPIは無くfake timersもDOに効かない
 * `Date.now()`の直接呼び出しはreaperの境界やリトライ予定時刻の検証を不能にするため必ずここを経由
 *
 * 加えてSpectre対策により同期実行中は`Date.now()`が進まない
 * DOのSQLiteは同期APIのためDO内での経過時間計測は無意味
 */
export type Clock = {
	now(): number;
};

export const systemClock: Clock = {
	now: () => Date.now(),
};

/** テスト用,任意の時刻に固定し明示的に進める */
export function fixedClock(start: number): Clock & { advance(ms: number): void; set(at: number): void } {
	let current = start;
	return {
		now: () => current,
		advance: (ms) => {
			current += ms;
		},
		set: (at) => {
			current = at;
		},
	};
}
