import { describe, expect, it } from 'vitest';
import { InvalidCronError, nextCronAt, parseCron } from '../../src/core/cron.js';

const at = (iso: string) => Date.parse(iso);

/** 式とafterからISO文字列へ, 期待値を読める形で書くため */
const next = (expression: string, after: string, timeZone?: string) =>
	new Date(nextCronAt(parseCron(expression), at(after), timeZone)).toISOString();

describe('cron式の解析', () => {
	it('全域と数値とリストと範囲とステップを受ける', () => {
		const spec = parseCron('*/15 0-6 1,15 3 1-5');
		expect([...spec.minutes]).toEqual([0, 15, 30, 45]);
		expect([...spec.hours]).toEqual([0, 1, 2, 3, 4, 5, 6]);
		expect([...spec.daysOfMonth]).toEqual([1, 15]);
		expect([...spec.months]).toEqual([3]);
		expect([...spec.daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
	});

	it('範囲へのステップを受ける', () => {
		expect([...parseCron('10-30/10 * * * *').minutes]).toEqual([10, 20, 30]);
	});

	it('曜日の7は0と同じ日曜になる', () => {
		expect([...parseCron('0 0 * * 7').daysOfWeek]).toEqual([0]);
	});

	it('フィールド数の過不足を拒否する', () => {
		expect(() => parseCron('* * * *')).toThrow(InvalidCronError);
		expect(() => parseCron('* * * * * *')).toThrow(InvalidCronError);
	});

	it('範囲外の値を拒否する', () => {
		expect(() => parseCron('60 * * * *')).toThrow(InvalidCronError);
		expect(() => parseCron('* 24 * * *')).toThrow(InvalidCronError);
		expect(() => parseCron('* * 0 * *')).toThrow(InvalidCronError);
		expect(() => parseCron('* * * 13 *')).toThrow(InvalidCronError);
		expect(() => parseCron('* * * * 8')).toThrow(InvalidCronError);
	});

	it('逆転した範囲と単一値へのステップと空の項を拒否する', () => {
		expect(() => parseCron('30-10 * * * *')).toThrow(InvalidCronError);
		expect(() => parseCron('5/2 * * * *')).toThrow(InvalidCronError);
		expect(() => parseCron('1,,2 * * * *')).toThrow(InvalidCronError);
	});

	it('名前と0のステップを拒否する', () => {
		expect(() => parseCron('0 0 * JAN *')).toThrow(InvalidCronError);
		expect(() => parseCron('*/0 * * * *')).toThrow(InvalidCronError);
	});
});

describe('次回時刻の計算', () => {
	it('次の分境界を返す', () => {
		expect(next('* * * * *', '2026-01-05T10:20:30Z')).toBe('2026-01-05T10:21:00.000Z');
	});

	it('ちょうど一致する時刻は返さず次を返す', () => {
		expect(next('0 3 * * *', '2026-01-05T03:00:00Z')).toBe('2026-01-06T03:00:00.000Z');
	});

	it('時と日を跨ぐ', () => {
		expect(next('0 3 * * *', '2026-01-05T04:00:00Z')).toBe('2026-01-06T03:00:00.000Z');
		expect(next('30 * * * *', '2026-01-05T23:45:00Z')).toBe('2026-01-06T00:30:00.000Z');
	});

	it('月と年を跨ぐ', () => {
		expect(next('0 0 15 * *', '2026-01-20T00:00:00Z')).toBe('2026-02-15T00:00:00.000Z');
		expect(next('59 23 31 12 *', '2026-01-01T00:00:00Z')).toBe('2026-12-31T23:59:00.000Z');
		expect(next('0 0 1 1 *', '2026-06-01T00:00:00Z')).toBe('2027-01-01T00:00:00.000Z');
	});

	it('日と曜日の両方に制限がある場合はOR判定になる', () => {
		// 2026-01-05は月曜, 13日より先の金曜(1/9)が当たる
		expect(next('0 0 13 * 5', '2026-01-05T12:00:00Z')).toBe('2026-01-09T00:00:00.000Z');
		// 金曜より先に13日が来る位置から
		expect(next('0 0 13 * 5', '2026-01-11T12:00:00Z')).toBe('2026-01-13T00:00:00.000Z');
	});

	it('曜日だけの指定は日と独立に適用される', () => {
		// 2026-01-05は月曜なので次の月曜は1/12
		expect(next('0 9 * * 1', '2026-01-05T10:00:00Z')).toBe('2026-01-12T09:00:00.000Z');
	});

	it('うるう日を跨いで見つける', () => {
		expect(next('0 0 29 2 *', '2025-03-01T00:00:00Z')).toBe('2028-02-29T00:00:00.000Z');
	});

	it('到達し得ない組み合わせは探索の上限でエラーになる', () => {
		expect(() => nextCronAt(parseCron('0 0 31 2 *'), at('2026-01-01T00:00:00Z'))).toThrow(InvalidCronError);
	});

	it('分のステップが日を跨いで先頭へ戻る', () => {
		expect(next('*/20 * * * *', '2026-01-05T23:45:00Z')).toBe('2026-01-06T00:00:00.000Z');
	});

	it('IANAタイムゾーンのローカル時刻で評価する', () => {
		expect(next('0 9 * * *', '2026-01-04T23:30:00Z', 'Asia/Tokyo')).toBe('2026-01-05T00:00:00.000Z');
	});

	it('タイムゾーン省略時はUTCを維持する', () => {
		const spec = parseCron('0 9 * * *');
		const after = at('2026-01-04T23:30:00Z');
		expect(nextCronAt(spec, after)).toBe(nextCronAt(spec, after, 'UTC'));
	});

	it('不正なタイムゾーンを拒否する', () => {
		expect(() => nextCronAt(parseCron('0 9 * * *'), at('2026-01-01T00:00:00Z'), 'Invalid/Zone')).toThrow(InvalidCronError);
	});

	it('固定オフセット識別子をIANAタイムゾーンとして受け付けない', () => {
		expect(() => nextCronAt(parseCron('0 9 * * *'), at('2026-01-01T00:00:00Z'), '+09:00')).toThrow(InvalidCronError);
		expect(next('0 9 * * *', '2026-01-04T23:30:00Z', 'Etc/GMT-9')).toBe('2026-01-05T00:00:00.000Z');
	});

	it('DST開始で存在しないローカル時刻を省略する', () => {
		expect(next('30 2 * * *', '2026-03-07T07:30:00Z', 'America/New_York')).toBe('2026-03-09T06:30:00.000Z');
	});

	it('DST終了で重複するローカル時刻は最初のUTC時刻だけを返す', () => {
		expect(next('30 1 * * *', '2026-10-31T05:30:00Z', 'America/New_York')).toBe('2026-11-01T05:30:00.000Z');
	});

	it('DST重複の最初のUTC時刻以後は2回目を返さず翌日へ進む', () => {
		expect(next('30 1 * * *', '2026-11-01T05:30:00Z', 'America/New_York')).toBe('2026-11-02T06:30:00.000Z');
		expect(next('30 1 * * *', '2026-11-01T05:31:00Z', 'America/New_York')).toBe('2026-11-02T06:30:00.000Z');
	});

	it('DST重複中の全分指定でも2回目の時刻帯を省略する', () => {
		expect(next('* * * * *', '2026-11-01T05:59:00Z', 'America/New_York')).toBe('2026-11-01T07:00:00.000Z');
		expect(next('* * * * *', '2026-11-01T06:15:00Z', 'America/New_York')).toBe('2026-11-01T07:00:00.000Z');
	});

	it('30分のDST開始で存在しないローカル時刻を省略する', () => {
		expect(next('15 2 * * *', '2026-10-02T15:45:00Z', 'Australia/Lord_Howe')).toBe('2026-10-04T15:15:00.000Z');
	});

	it('30分のDST終了で重複するローカル時刻は最初のUTC時刻だけを返す', () => {
		expect(next('45 1 * * *', '2026-04-03T14:45:00Z', 'Australia/Lord_Howe')).toBe('2026-04-04T14:45:00.000Z');
		expect(next('45 1 * * *', '2026-04-04T14:45:00Z', 'Australia/Lord_Howe')).toBe('2026-04-05T15:15:00.000Z');
	});
});
