import { describe, expect, it } from 'vitest';
import { InvalidCronError, nextCronAt, parseCron } from '../../src/core/cron.js';

const next = (expression: string, after: string, timeZone: string): string =>
	new Date(nextCronAt(parseCron(expression), Date.parse(after), timeZone)).toISOString();

describe('workerdのcronタイムゾーン', () => {
	it('IntlでIANAタイムゾーンを評価する', () => {
		expect(next('0 9 * * *', '2026-01-04T23:30:00Z', 'Asia/Tokyo')).toBe('2026-01-05T00:00:00.000Z');
	});

	it('Intlが受理する固定オフセット識別子を拒否する', () => {
		expect(() => next('0 9 * * *', '2026-01-04T23:30:00Z', '+09:00')).toThrow(InvalidCronError);
	});

	it('DSTの欠落と重複の方針を維持する', () => {
		expect(next('30 2 * * *', '2026-03-07T07:30:00Z', 'America/New_York')).toBe('2026-03-09T06:30:00.000Z');
		expect(next('30 1 * * *', '2026-10-31T05:30:00Z', 'America/New_York')).toBe('2026-11-01T05:30:00.000Z');
		expect(next('30 1 * * *', '2026-11-01T05:30:00Z', 'America/New_York')).toBe('2026-11-02T06:30:00.000Z');
	});
});
