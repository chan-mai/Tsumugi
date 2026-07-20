/**
 * 注入可能な時計
 *
 * Workersに時間を進めるAPIは無くfake timersもDOに効かない
 * DOが`Date.now()`を直接呼ぶとreaperの境界やリトライの予定時刻をテストできなくなるため,必ずここを経由する
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

/** テストで任意の時刻に固定し,明示的に進めるための時計 */
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
