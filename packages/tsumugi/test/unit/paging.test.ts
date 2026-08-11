import { describe, expect, it } from 'vitest';
import { parsePaging } from '../../src/api/rest.js';

const parse = (query: string) => parsePaging(new URL(`https://example.com/api/jobs${query}`));

describe('一覧のページング', () => {
	it('指定が無ければ既定値を返す', () => {
		expect(parse('')).toEqual({ limit: 20, offset: 0 });
	});

	it('指定を読み取る', () => {
		expect(parse('?limit=50&offset=100')).toEqual({ limit: 50, offset: 100 });
	});

	it('limitを上限で切る', () => {
		expect(parse('?limit=1000')).toEqual({ limit: 100, offset: 0 });
	});

	it('負のlimitを既定値にする', () => {
		// SQLiteのLIMIT -1は無制限
		expect(parse('?limit=-1')).toEqual({ limit: 20, offset: 0 });
		expect(parse('?limit=-500')).toEqual({ limit: 20, offset: 0 });
	});

	it('小数を既定値にする', () => {
		// D1はdatatype mismatch
		expect(parse('?limit=1.5')).toEqual({ limit: 20, offset: 0 });
		expect(parse('?offset=2.5')).toEqual({ limit: 20, offset: 0 });
	});

	it('安全な整数を超える値を既定値にする', () => {
		expect(parse('?offset=1e20')).toEqual({ limit: 20, offset: 0 });
	});

	it('数値にならない値と空文字を既定値にする', () => {
		expect(parse('?limit=abc&offset=abc')).toEqual({ limit: 20, offset: 0 });
		expect(parse('?limit=&offset=')).toEqual({ limit: 20, offset: 0 });
	});

	it('負のoffsetを0にする', () => {
		expect(parse('?offset=-5')).toEqual({ limit: 20, offset: 0 });
	});
});
