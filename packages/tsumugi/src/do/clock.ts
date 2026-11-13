/**
 * 注入可能な時計, Workersに時刻操作API無くDOでfake timers無効
 * `Temporal.Now.instant().epochMilliseconds`直接呼び出し禁止, reaper境界やリトライ時刻の検証不能
 * Spectre対策で同期実行中の`Temporal.Now.instant().epochMilliseconds`は不変, 同期SQLiteのDO内計測は無意味
 */
export type Clock = {
	now(): number;
};

export const systemClock: Clock = {
	now: () => Temporal.Now.instant().epochMilliseconds,
};

export function fixedClock(start: number): Clock & { advance(ms: number): void; set(at: number): void } {
	let current = start;
	return {
		now: () => current,
		advance: ms => {
			current += ms;
		},
		set: at => {
			current = at;
		},
	};
}
