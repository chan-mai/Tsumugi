import { describe, expect, it } from 'vitest';
import { resolveSort, SORTABLE_COLUMNS } from '../../src/api/rest.js';

describe('一覧の並べ替え', () => {
	it('既定は更新の新しい順', () => {
		expect(resolveSort(null, null)).toEqual({ column: 'updated_at', desc: true });
	});

	it('許可した列を受け付ける', () => {
		for (const column of SORTABLE_COLUMNS) {
			expect(resolveSort(column, 'asc')).toEqual({ column, desc: false });
		}
	});

	it('許可していない列は既定に落とす', () => {
		// 列名はSQLへの直接差し込み,漏れはそのまま注入
		for (const injection of ['payload', 'id; DROP TABLE job', '(SELECT 1)', '', 'UPDATED_AT']) {
			expect(resolveSort(injection, null).column).toBe('updated_at');
		}
	});

	it('asc以外の向きは降順として扱う', () => {
		expect(resolveSort('attempts', 'desc').desc).toBe(true);
		expect(resolveSort('attempts', 'nonsense').desc).toBe(true);
		expect(resolveSort('attempts', null).desc).toBe(true);
	});
});
