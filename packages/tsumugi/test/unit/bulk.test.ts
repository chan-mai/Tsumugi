import { describe, expect, it } from 'vitest';
import { BULK_LIMIT_MAX, groupByShard, validateBulk } from '../../src/api/rest.js';

describe('一括操作の対象の検証', () => {
	it('IDの列挙をそのまま対象にする', () => {
		expect(validateBulk({ ids: ['MAIL#0:a', 'MAIL#0:b'] }, 'retry')).toEqual({
			input: { kind: 'ids', ids: ['MAIL#0:a', 'MAIL#0:b'] },
		});
	});

	it('IDが空や上限超過なら拒否する', () => {
		expect(validateBulk({ ids: [] }, 'retry')).toEqual({ error: 'ids must not be empty' });
		expect(validateBulk({ ids: 'MAIL#0:a' }, 'retry')).toEqual({ error: 'ids must be an array' });
		expect(validateBulk({ ids: ['', 'MAIL#0:a'] }, 'retry')).toEqual({ error: 'ids must be non-empty strings' });
		expect(validateBulk({ ids: Array.from({ length: BULK_LIMIT_MAX + 1 }, (_, i) => `MAIL#0:${i}`) }, 'retry')).toEqual({
			error: `ids must not exceed ${BULK_LIMIT_MAX} entries`,
		});
	});

	it('未指定なら操作が受け付ける状態すべてを対象にする', () => {
		expect(validateBulk({}, 'retry')).toEqual({ input: { kind: 'filter', states: ['FAILED', 'STALLED'], limit: BULK_LIMIT_MAX } });
		expect(validateBulk({}, 'cancel')).toEqual({
			input: { kind: 'filter', states: ['SCHEDULED', 'QUEUED', 'RUNNING'], limit: BULK_LIMIT_MAX },
		});
	});

	it('受け付ける状態の中からなら1つに限定できる', () => {
		expect(validateBulk({ state: 'STALLED' }, 'retry')).toEqual({
			input: { kind: 'filter', states: ['STALLED'], limit: BULK_LIMIT_MAX },
		});
	});

	it('操作が受け付けない状態を拒否する', () => {
		// 対象不減時の残件数追跡ループの無限化防止
		expect(validateBulk({ state: 'RUNNING' }, 'retry')).toEqual({ error: 'state must be one of FAILED, STALLED for retry' });
		expect(validateBulk({ state: 'FAILED' }, 'cancel')).toEqual({
			error: 'state must be one of SCHEDULED, QUEUED, RUNNING for cancel',
		});
	});

	it('抽出条件を引き継ぐ', () => {
		expect(validateBulk({ binding: 'MAIL', unique_key: 'u1', concurrency_key: 'c1', created_from: 1, created_to: 2 }, 'retry')).toEqual({
			input: {
				kind: 'filter',
				states: ['FAILED', 'STALLED'],
				limit: BULK_LIMIT_MAX,
				binding: 'MAIL',
				uniqueKey: 'u1',
				concurrencyKey: 'c1',
				createdFrom: 1,
				createdTo: 2,
			},
		});
	});

	it('上限を超えるlimitを切り詰める', () => {
		expect(validateBulk({ limit: 10_000 }, 'retry')).toMatchObject({ input: { limit: BULK_LIMIT_MAX } });
		expect(validateBulk({ limit: 5 }, 'retry')).toMatchObject({ input: { limit: 5 } });
	});

	it('不正な型と値を拒否する', () => {
		expect(validateBulk(null, 'retry')).toEqual({ error: 'body must be an object' });
		expect(validateBulk({ binding: 1 }, 'retry')).toEqual({ error: 'binding must be a string' });
		expect(validateBulk({ limit: 0 }, 'retry')).toEqual({ error: 'limit must be at least 1' });
		expect(validateBulk({ limit: 1.5 }, 'retry')).toEqual({ error: 'limit must be an integer' });
		expect(validateBulk({ created_from: 'today' }, 'retry')).toEqual({ error: 'created_from must be an integer' });
	});
});

describe('shardごとのまとめ', () => {
	it('同じshardのジョブを1つにまとめる', () => {
		const { groups, invalid } = groupByShard(['MAIL#0:a', 'MAIL#0:b', 'MAIL#1:c', 'CHARGE#0:d']);

		expect([...groups.entries()]).toEqual([
			['MAIL#0', ['MAIL#0:a', 'MAIL#0:b']],
			['MAIL#1', ['MAIL#1:c']],
			['CHARGE#0', ['CHARGE#0:d']],
		]);
		expect(invalid).toEqual([]);
	});

	it('形式が壊れたIDは分けて返す', () => {
		// 読み取りモデルに不正行があっても他対象の処理は継続
		const { groups, invalid } = groupByShard(['MAIL#0:a', 'broken']);

		expect([...groups.keys()]).toEqual(['MAIL#0']);
		expect(invalid).toEqual(['broken']);
	});
});
