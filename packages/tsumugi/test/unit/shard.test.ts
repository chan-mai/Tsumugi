import { describe, expect, it } from 'vitest';
import { InvalidJobIdError } from '../../src/core/ids.js';
import { hashToShard, resolveShard } from '../../src/core/shard.js';

describe('hashToShard', () => {
	it('分割していなければ常に0', () => {
		expect(hashToShard('cust-1', 1)).toBe(0);
		expect(hashToShard('cust-2', 0)).toBe(0);
	});

	it('同じキーは常に同じshardに落ちる', () => {
		for (const key of ['cust-1', 'order:9', '']) {
			expect(hashToShard(key, 8)).toBe(hashToShard(key, 8));
		}
	});

	it('範囲を外れない', () => {
		for (let i = 0; i < 500; i++) {
			const shard = hashToShard(`key-${i}`, 4);
			expect(shard).toBeGreaterThanOrEqual(0);
			expect(shard).toBeLessThan(4);
		}
	});

	it('偏りすぎない', () => {
		const counts = [0, 0, 0, 0];
		for (let i = 0; i < 1000; i++) counts[hashToShard(`cust-${i}`, 4)]!++;
		// 完全な均等は求めないが, 1つのshardに寄りすぎていないこと
		for (const count of counts) expect(count).toBeGreaterThan(150);
	});
});

describe('resolveShard (ADR-0011)', () => {
	it('分割していなければpartitionKey無しでも通る', () => {
		expect(resolveShard('MAIL', 1, undefined)).toBe(0);
	});

	it('分割しているのにpartitionKeyが無ければ拒否する', () => {
		// 黙って0番に落とすとキー単位の制御も重複排除も静かに破れる
		expect(() => resolveShard('MAIL', 4, undefined)).toThrow(InvalidJobIdError);
	});

	it('partitionKeyがあればハッシュで決まる', () => {
		expect(resolveShard('MAIL', 4, 'cust-1')).toBe(hashToShard('cust-1', 4));
	});
});
