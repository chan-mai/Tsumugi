/**
 * 注入可能な時計, Workersに時刻操作API無くDOでfake timers無効
 * `Date.now()`直接呼び出し禁止, reaper境界やリトライ時刻の検証不能
 * Spectre対策で同期実行中の`Date.now()`は不変, 同期SQLiteのDO内計測は無意味
 */
export type Clock = {
	now(): number;
};

export const systemClock: Clock = {
	now: () => Date.now(),
};

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
