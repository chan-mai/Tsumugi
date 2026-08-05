import { describe, expect, it } from 'vitest';
import { InvalidScheduleError, nextOccurrence, normalizeSchedules, type AnySchedules } from '../../src/core/recurring.js';

const context = { bindings: ['Greet', 'Wide'], flows: ['GREETINGS'], shardsOf: (binding: string) => (binding === 'Wide' ? 4 : 1) };

const normalize = (defs: AnySchedules) => normalizeSchedules(defs, context);

describe('scheduleの正規化', () => {
	it('検証済みの正規形とfingerprintを返す', () => {
		const { schedules, fingerprint } = normalize({
			hello: { binding: 'Greet', payload: {}, everyMs: 60_000 },
			nightly: { flow: 'GREETINGS', input: {}, cron: '0 3 * * *', overlap: 'overlap' },
		});
		expect(schedules).toEqual([
			{ name: 'hello', kind: 'job', target: 'Greet', everyMs: 60_000, cron: null, overlap: 'skip' },
			{ name: 'nightly', kind: 'flow', target: 'GREETINGS', everyMs: null, cron: '0 3 * * *', overlap: 'overlap' },
		]);
		expect(fingerprint).toBe(JSON.stringify(schedules));
	});

	it('fingerprintは定義の記述順に依存しない', () => {
		const a = normalize({ x: { binding: 'Greet', payload: {}, everyMs: 60_000 }, y: { flow: 'GREETINGS', input: {}, cron: '0 * * * *' } });
		const b = normalize({ y: { flow: 'GREETINGS', input: {}, cron: '0 * * * *' }, x: { binding: 'Greet', payload: {}, everyMs: 60_000 } });
		expect(a.fingerprint).toBe(b.fingerprint);
	});

	it('名前の文字種と長さを弾く', () => {
		expect(() => normalize({ 'a:b': { binding: 'Greet', payload: {}, everyMs: 60_000 } })).toThrow(InvalidScheduleError);
		expect(() => normalize({ ['a'.repeat(65)]: { binding: 'Greet', payload: {}, everyMs: 60_000 } })).toThrow(InvalidScheduleError);
	});

	it('uniqueKeyとdelayMsとrunAtの混入を弾く', () => {
		for (const key of ['uniqueKey', 'delayMs', 'runAt']) {
			expect(() => normalize({ x: { binding: 'Greet', payload: {}, everyMs: 60_000, [key]: 1 } })).toThrow(InvalidScheduleError);
		}
	});

	it('everyMsとcronの排他を弾く', () => {
		expect(() => normalize({ x: { binding: 'Greet', payload: {} } })).toThrow(InvalidScheduleError);
		expect(() => normalize({ x: { binding: 'Greet', payload: {}, everyMs: 60_000, cron: '* * * * *' } })).toThrow(InvalidScheduleError);
	});

	it('短すぎるeveryMsと小数を弾く', () => {
		expect(() => normalize({ x: { binding: 'Greet', payload: {}, everyMs: 999 } })).toThrow(InvalidScheduleError);
		expect(() => normalize({ x: { binding: 'Greet', payload: {}, everyMs: 1000.5 } })).toThrow(InvalidScheduleError);
	});

	it('不正なcronと到達し得ないcronを弾く', () => {
		expect(() => normalize({ x: { binding: 'Greet', payload: {}, cron: '* * *' } })).toThrow(InvalidScheduleError);
		expect(() => normalize({ x: { binding: 'Greet', payload: {}, cron: '0 0 31 2 *' } })).toThrow(InvalidScheduleError);
	});

	it('bindingとflowの排他と未登録を弾く', () => {
		expect(() => normalize({ x: { everyMs: 60_000 } })).toThrow(InvalidScheduleError);
		expect(() => normalize({ x: { binding: 'Greet', flow: 'GREETINGS', payload: {}, input: {}, everyMs: 60_000 } })).toThrow(
			InvalidScheduleError,
		);
		expect(() => normalize({ x: { binding: 'Nope', payload: {}, everyMs: 60_000 } })).toThrow(InvalidScheduleError);
		expect(() => normalize({ x: { flow: 'Nope', input: {}, everyMs: 60_000 } })).toThrow(InvalidScheduleError);
	});

	it('payloadとinputの欠落を弾く', () => {
		expect(() => normalize({ x: { binding: 'Greet', everyMs: 60_000 } })).toThrow(InvalidScheduleError);
		expect(() => normalize({ x: { flow: 'GREETINGS', everyMs: 60_000 } })).toThrow(InvalidScheduleError);
	});

	it('overlapの不正値を弾く', () => {
		expect(() => normalize({ x: { binding: 'Greet', payload: {}, everyMs: 60_000, overlap: 'wait' as never } })).toThrow(
			InvalidScheduleError,
		);
	});

	it('分割されたbindingはpartitionKeyが要る', () => {
		expect(() => normalize({ x: { binding: 'Wide', payload: {}, everyMs: 60_000 } })).toThrow(InvalidScheduleError);
		expect(() => normalize({ x: { binding: 'Wide', payload: {}, everyMs: 60_000, partitionKey: 'x' } })).not.toThrow();
	});
});

describe('次回時刻の前進', () => {
	const every = { everyMs: 60_000, cron: null };

	it('初回は今から1間隔後', () => {
		expect(nextOccurrence(every, null, 1_000_000)).toBe(1_060_000);
	});

	it('位相を保って進む', () => {
		// 予定100万msの発火が5秒遅れても次回は予定基準
		expect(nextOccurrence(every, 1_000_000, 1_005_000)).toBe(1_060_000);
	});

	it('取り逃した分は発火せず飛ばす', () => {
		// 3周期半が経過, 次はceil側の境界1つだけ
		expect(nextOccurrence(every, 1_000_000, 1_210_000)).toBe(1_240_000);
	});

	it('ちょうど境界の場合も次の境界へ進む', () => {
		expect(nextOccurrence(every, 1_000_000, 1_060_000)).toBe(1_120_000);
	});

	it('cronは前回と今の遅い方から次を引く', () => {
		const timing = { everyMs: null, cron: '0 3 * * *' };
		const previous = Date.parse('2026-01-05T03:00:00Z');
		const lateNow = Date.parse('2026-01-07T12:00:00Z');
		expect(nextOccurrence(timing, previous, lateNow)).toBe(Date.parse('2026-01-08T03:00:00Z'));
	});
});
