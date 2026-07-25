import { describe, expect, it } from 'vitest';
import { parseJobFilters } from '../../src/api/rest.js';

const parse = (query: string) => parseJobFilters(new URL(`https://example.com/api/jobs${query}`));

describe('一覧の絞り込み条件', () => {
	it('指定が無ければ何も返さない', () => {
		expect(parse('')).toEqual({});
	});

	it('キーと期間を読み取る', () => {
		expect(parse('?id=MAIL%230:abc&unique_key=u1&concurrency_key=c1&created_from=100&created_to=200')).toEqual({
			id: 'MAIL#0:abc',
			uniqueKey: 'u1',
			concurrencyKey: 'c1',
			createdFrom: 100,
			createdTo: 200,
		});
	});

	it('空文字は指定なしとして扱う', () => {
		// 入力欄を空にした状態がそのまま送られてくる
		expect(parse('?id=&unique_key=')).toEqual({});
	});

	it('数値にならない期間を無視する', () => {
		// 400にすると入力の途中で画面が止まる
		expect(parse('?created_from=yesterday')).toEqual({});
		expect(parse('?created_to=')).toEqual({});
	});

	it('片方だけの期間も受け付ける', () => {
		expect(parse('?created_from=100')).toEqual({ createdFrom: 100 });
		expect(parse('?created_to=200')).toEqual({ createdTo: 200 });
	});

	it('0を指定なしと混同しない', () => {
		expect(parse('?created_from=0')).toEqual({ createdFrom: 0 });
	});
});
