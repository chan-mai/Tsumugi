import { describe, expect, it } from 'vitest';
import { assertPayloadSize, PAYLOAD_MAX_BYTES, PayloadTooLargeError, splitBatches } from '../../src/core/message.js';

describe('assertPayloadSize', () => {
	it('JSONのUTF-8バイト数で判定する', () => {
		// 3バイト文字, 文字数では上限未満
		expect(() => assertPayloadSize('あ'.repeat(PAYLOAD_MAX_BYTES / 3))).toThrow(PayloadTooLargeError);
		expect(() => assertPayloadSize('x'.repeat(PAYLOAD_MAX_BYTES - 2))).not.toThrow();
		expect(() => assertPayloadSize(undefined)).not.toThrow();
	});
});

describe('splitBatches', () => {
	it('100件ごとに分割する', () => {
		const { batches } = splitBatches(Array.from({ length: 250 }, (_, i) => ({ i })));
		expect(batches.map(b => b.length)).toEqual([100, 100, 50]);
	});

	it('合計256KBを超えないよう分割する', () => {
		const { batches } = splitBatches(Array.from({ length: 10 }, () => 'x'.repeat(60_000)));
		expect(batches.map(b => b.length)).toEqual([4, 4, 2]);
	});

	it('単独で128KBを超えるメッセージは分離する', () => {
		const big = 'x'.repeat(128_000);
		const { batches, oversized } = splitBatches(['a', big, 'b']);
		expect(batches).toEqual([['a', 'b']]);
		expect(oversized).toEqual([big]);
	});
});
