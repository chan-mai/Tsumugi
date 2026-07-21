import { describe, expect, it } from 'vitest';
import { attemptsOf, resolveSort, SORTABLE_COLUMNS } from '../../src/api/rest.js';
import { describeError } from '../../src/queue/consumer.js';

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

describe('1回目で成功した試行の組み立て(ADR-0028)', () => {
	const done = { state: 'COMPLETED', attempts: 1, dispatched_at: 1_000, updated_at: 1_500 };

	it('ジョブ行から1件を組み立てる', () => {
		expect(attemptsOf(done, [])).toEqual([{ attempt: 1, state: 'COMPLETED', started_at: 1_000, finished_at: 1_500, error: null }]);
	});

	it('保存された履歴があればそちらを使う', () => {
		// 組み立てた1件で上書きすると失敗の理由が消える
		const stored = [{ attempt: 2, state: 'COMPLETED', started_at: 5, finished_at: 6, error: null }];
		expect(attemptsOf(done, stored)).toBe(stored);
	});

	it('実行に至っていないジョブは組み立てない', () => {
		for (const job of [
			{ state: 'QUEUED', attempts: 0, dispatched_at: 1_000, updated_at: 1_500 },
			{ state: 'CANCELLED', attempts: 0, dispatched_at: null, updated_at: 1_500 },
			{ state: 'STALLED', attempts: 1, dispatched_at: 1_000, updated_at: 1_500 },
			{ state: 'FAILED', attempts: 1, dispatched_at: 1_000, updated_at: 1_500 },
		]) {
			expect(attemptsOf(job, []), job.state).toEqual([]);
		}
	});
});

describe('例外の文字列化(ADR-0028)', () => {
	it('stackをそのまま使う', () => {
		// stackは1行目にName: messageを含む, 繋げると同じ行が2回出る
		const error = new Error('boom');
		const text = describeError(error);
		expect(text.split('\n').filter((l) => l.includes('Error: boom'))).toHaveLength(1);
	});

	it('stackが無ければ名前とメッセージで組み立てる', () => {
		const error = new Error('boom');
		delete (error as { stack?: string }).stack;
		expect(describeError(error)).toBe('Error: boom');
	});

	it('Error以外もそのまま文字列にする', () => {
		expect(describeError('plain string')).toBe('plain string');
		expect(describeError(42)).toBe('42');
	});
});
