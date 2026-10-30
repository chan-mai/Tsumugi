import { describe, expect, it } from 'vitest';
import { toUpserts } from '../../src/projection/projector.js';

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
	const [upsert] = toUpserts([{ seq: 1, job_id: 'A#0:x', snapshot }]);
	return upsert!.sql.slice(upsert!.sql.indexOf('DO UPDATE SET'));
};

describe('投影のUPSERTが更新する列', () => {
	it('不変の列を更新しない', () => {
		// 除外漏れは警告なしで影響拡大
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

	it('古いseqの上書きを防止する条件が残っている', () => {
		expect(setClauseOf()).toContain('WHERE excluded.seq > job.seq');
	});
});
