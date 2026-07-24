import { describe, expect, it } from 'vitest';
import { toStatements } from '../../src/projection/projector.js';

const snapshot = JSON.stringify({
	id: 'A#0:x',
	binding: 'A',
	state: 'QUEUED',
	priority: 0,
	attempts: 1,
	max_attempts: 3,
	concurrency_key: null,
	unique_key: null,
	guarantee: 'at-least-once',
	created_at: 1,
	updated_at: 2,
	dispatched_at: null,
	payload: '{}',
	run_id: null,
	node_id: null,
});

const setClauseOf = () => {
	const [stmt] = toStatements({} as D1Database, [{ seq: 1, job_id: 'A#0:x', snapshot }]);
	const text = (stmt as unknown as { toSQL(): { sql: string } }).toSQL().sql;
	return text.slice(text.indexOf('do update set'));
};

describe('投影のUPSERTが更新する列', () => {
	it('不変の列を更新しない', () => {
		// 移行前のSQLもこの4列を外していた, 分割代入で漏らすと黙って広がる
		const set = setClauseOf();
		for (const column of ['"id"', '"binding"', '"guarantee"', '"created_at"']) {
			expect(set.includes(`${column} = `), `${column}が更新対象に入っている`).toBe(false);
		}
	});

	it('変わり得る列は更新する', () => {
		const set = setClauseOf();
		for (const column of ['"seq"', '"state"', '"attempts"', '"updated_at"', '"payload"', '"result"', '"attempts_log"']) {
			expect(set.includes(`${column} = `), `${column}が更新対象から漏れている`).toBe(true);
		}
	});

	it('古いseqの上書きを弾く条件が残っている', () => {
		expect(setClauseOf()).toContain('excluded');
	});
});
