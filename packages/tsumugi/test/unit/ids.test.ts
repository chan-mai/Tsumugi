import { describe, expect, it } from 'vitest';
import { InvalidJobIdError, formatJobId, parseJobId, shardName, shardNameOf } from '../../src/core/ids.js';

describe('ジョブIDの往復', () => {
	it('formatしてparseすると元に戻る', () => {
		const address = { binding: 'SEND_MAIL', shard: 0, localId: 'clx1a2b3c4d5e6f7g8h9' };
		expect(parseJobId(formatJobId(address))).toEqual(address);
	});

	it('shardが複数桁でも往復する', () => {
		const address = { binding: 'CHARGE', shard: 127, localId: 'abc123' };
		expect(parseJobId(formatJobId(address))).toEqual(address);
	});

	it('見た目の形式が期待通り', () => {
		expect(formatJobId({ binding: 'MAIL', shard: 0, localId: 'abc' })).toBe('MAIL#0:abc');
	});

	it('IDからDO名を引ける', () => {
		expect(shardNameOf('MAIL#3:abc')).toBe('MAIL#3');
		expect(shardName('MAIL', 3)).toBe('MAIL#3');
	});
});

describe('不正なbindingを拒否する', () => {
	// 区切り文字の混入でparseが壊れる,ここが崩れるとID体系全体が崩れる
	it.each(['MA#IL', 'MA:IL', 'MAIL#0', '', '1MAIL', 'MA IL', 'MA-IL', 'メール'])('%oを拒否する', (binding) => {
		expect(() => formatJobId({ binding, shard: 0, localId: 'abc' })).toThrow(InvalidJobIdError);
	});

	it('英字始まりの英数字とアンダースコアは通す', () => {
		for (const binding of ['MAIL', '_mail', 'sendMail2', 'A']) {
			expect(() => formatJobId({ binding, shard: 0, localId: 'abc' })).not.toThrow();
		}
	});
});

describe('不正なshardを拒否する', () => {
	it.each([-1, 1.5, NaN, Infinity])('%oを拒否する', (shard) => {
		expect(() => formatJobId({ binding: 'MAIL', shard, localId: 'abc' })).toThrow(InvalidJobIdError);
	});
});

describe('不正なlocalIdを拒否する', () => {
	it.each(['', 'a:b', 'a#b', 'a b', 'あ'])('%oを拒否する', (localId) => {
		expect(() => formatJobId({ binding: 'MAIL', shard: 0, localId })).toThrow(InvalidJobIdError);
	});
});

describe('parseの入力検証', () => {
	it.each([
		['MAIL:abc', '#がない'],
		['MAIL#0', ':がない'],
		['MAIL#x:abc', 'shardが数値でない'],
		['MAIL#-1:abc', 'shardが負'],
		['#0:abc', 'bindingが空'],
		['MA#IL#0:abc', 'bindingに#が入っている'],
		['MAIL#0:a:b', 'localIdに:が入っている'],
		['MAIL#0:', 'localIdが空'],
	])('%oを拒否する(%s)', (jobId) => {
		expect(() => parseJobId(jobId)).toThrow(InvalidJobIdError);
	});
});
