import { describe, expect, it } from 'vitest';
import { normalizeTraceparent } from '../../src/core/trace.js';

const valid = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('traceparentの検証', () => {
	it('version 00の値を変更せず返す', () => {
		expect(normalizeTraceparent(valid)).toBe(valid);
		expect(normalizeTraceparent(valid.slice(0, -2) + '00')).toBe(valid.slice(0, -2) + '00');
	});

	it('未指定はnullを返す', () => {
		expect(normalizeTraceparent(undefined)).toBeNull();
		expect(normalizeTraceparent(null)).toBeNull();
	});

	it.each([
		'',
		42,
		{},
		valid.toUpperCase(),
		` ${valid}`,
		`${valid}-extra`,
		`${valid}\n`,
		valid.replace(/^00/, 'ff'),
		valid.replace(/^00/, '01'),
		valid.replace('4bf92f3577b34da6a3ce929d0e0e4736', '0'.repeat(32)),
		valid.replace('00f067aa0ba902b7', '0'.repeat(16)),
	])('不正な値を受け付けない(%j)', (value) => {
		expect(() => normalizeTraceparent(value)).toThrow(/traceparent/);
	});
});
