import { describe, expect, it } from 'vitest';
import { validateCreateJob } from '../../src/api/rest.js';

const BINDINGS = ['MAIL', 'CHARGE'];

const ok = (body: unknown) => validateCreateJob(body, BINDINGS);

describe('投入内容の検証', () => {
	it('最小構成が通る', () => {
		expect(ok({ binding: 'MAIL', payload: { to: 'a@example.com' } })).toEqual({
			input: { binding: 'MAIL', payload: { to: 'a@example.com' } },
		});
	});

	it('payloadはnullでも空オブジェクトでも通る', () => {
		expect(ok({ binding: 'MAIL', payload: null })).toHaveProperty('input');
		expect(ok({ binding: 'MAIL', payload: {} })).toHaveProperty('input');
	});

	it('未登録のbindingを拒否する', () => {
		// 投入はできても実行時に必ず失敗するので入口で弾く
		expect(ok({ binding: 'NOPE', payload: {} })).toEqual({ error: 'unknown binding: NOPE' });
	});

	it('bindingが無ければ拒否する', () => {
		expect(ok({ payload: {} })).toEqual({ error: 'binding is required' });
		expect(ok({ binding: '', payload: {} })).toEqual({ error: 'binding is required' });
	});

	it('payloadが無ければ拒否する', () => {
		expect(ok({ binding: 'MAIL' })).toEqual({ error: 'payload is required' });
	});

	it('オブジェクト以外を拒否する', () => {
		for (const body of [null, 'text', 42, undefined]) {
			expect(ok(body)).toEqual({ error: 'body must be an object' });
		}
	});

	it('数値でない指定を拒否する', () => {
		expect(ok({ binding: 'MAIL', payload: {}, maxAttempts: '3' })).toEqual({ error: 'maxAttempts must be a number' });
		expect(ok({ binding: 'MAIL', payload: {}, delayMs: Number.NaN })).toEqual({ error: 'delayMs must be a number' });
		expect(ok({ binding: 'MAIL', payload: {}, priority: Number.POSITIVE_INFINITY })).toEqual({ error: 'priority must be a number' });
	});

	it('範囲外の指定を拒否する', () => {
		expect(ok({ binding: 'MAIL', payload: {}, maxAttempts: 0 })).toEqual({ error: 'maxAttempts must be at least 1' });
		expect(ok({ binding: 'MAIL', payload: {}, delayMs: -1 })).toEqual({ error: 'delayMs must not be negative' });
	});

	it('キーは文字列でなければ拒否する', () => {
		expect(ok({ binding: 'MAIL', payload: {}, uniqueKey: 1 })).toEqual({ error: 'uniqueKey must be a string' });
		expect(ok({ binding: 'MAIL', payload: {}, concurrencyKey: {} })).toEqual({ error: 'concurrencyKey must be a string' });
	});

	it('任意項目を取り込む', () => {
		const result = ok({
			binding: 'CHARGE',
			payload: { amount: 1 },
			maxAttempts: 5,
			delayMs: 1_000,
			priority: 2,
			uniqueKey: 'u',
			concurrencyKey: 'c',
		});
		expect(result).toEqual({
			input: {
				binding: 'CHARGE',
				payload: { amount: 1 },
				maxAttempts: 5,
				delayMs: 1_000,
				priority: 2,
				uniqueKey: 'u',
				concurrencyKey: 'c',
			},
		});
	});

	it('空文字のキーは付けない', () => {
		expect(ok({ binding: 'MAIL', payload: {}, uniqueKey: '', concurrencyKey: '' })).toEqual({
			input: { binding: 'MAIL', payload: {} },
		});
	});

	it('登録一覧が空ならbindingの照合をしない', () => {
		// createRestに登録名を渡していない構成でも動くようにする
		expect(validateCreateJob({ binding: 'ANY', payload: {} }, [])).toHaveProperty('input');
	});
});
