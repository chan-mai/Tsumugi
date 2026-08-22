import { describe, expect, it } from 'vitest';
import { browserTimeZone, formatTimestamp } from '../../src/time';

describe('ダッシュボードの日時表示', () => {
	it('IANAタイムゾーンと時点固有のGMTオフセットを表示する', () => {
		const value = formatTimestamp(Date.parse('2026-01-05T00:00:00Z'), 'Asia/Tokyo');
		expect(value).toContain('Asia/Tokyo');
		expect(value).toContain('GMT+09:00');
	});

	it('DSTで重複するローカル時刻をオフセットで区別する', () => {
		const first = formatTimestamp(Date.parse('2026-11-01T05:30:00Z'), 'America/New_York');
		const second = formatTimestamp(Date.parse('2026-11-01T06:30:00Z'), 'America/New_York');
		expect(first).toContain('GMT-04:00');
		expect(second).toContain('GMT-05:00');
		expect(first).not.toBe(second);
	});

	it('省略時はブラウザのIANAタイムゾーンを使う', () => {
		expect(formatTimestamp(Date.parse('2026-01-05T00:00:00Z'))).toContain(`[${browserTimeZone()}]`);
	});

	it('UTCも数値オフセットを表示する', () => {
		const value = formatTimestamp(Date.parse('2026-01-05T00:00:00Z'), 'UTC');
		expect(value).toContain('GMT+00:00');
		expect(value).toContain('[UTC]');
	});
});
