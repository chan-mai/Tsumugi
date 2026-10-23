import { describe, expect, it } from 'vitest';
import { SORT_KEYS, toJobDetail, toRunNode } from '../../src/api/mapper.js';
import { SORTABLE_COLUMNS } from '../../src/api/sort.js';
import type { Job } from '../../src/core/entity/job.entity.js';
import type { RunNode } from '../../src/core/entity/run.entity.js';

const attempt = { attempt: 1, state: 'FAILED', startedAt: 10, finishedAt: 20, error: 'boom' };

describe('レスポンスへの変換', () => {
	it('並べ替えの列名を全てエンティティのキーへ対応させる', () => {
		for (const column of SORTABLE_COLUMNS) expect(SORT_KEYS[column], column).toBeDefined();
	});

	it('ジョブ詳細は試行のエラー本文を含めsnake_caseで返す', () => {
		const job = {
			id: 'Boom#0:a',
			binding: 'Boom',
			state: 'FAILED',
			priority: 0,
			attempts: 1,
			maxAttempts: 1,
			concurrencyKey: null,
			uniqueKey: null,
			guarantee: 'at-least-once',
			createdAt: 1,
			updatedAt: 2,
			dispatchedAt: 3,
			runAfter: null,
			expiresAt: null,
			cancelRequestedAt: null,
			progress: null,
			traceparent: null,
			logs: [],
			payload: '{}',
			result: null,
			runId: null,
			nodeId: null,
			attemptsLog: [attempt],
			retryable: true,
		} satisfies Job & { retryable: boolean };
		const detail = toJobDetail(job);
		expect(detail.max_attempts).toBe(1);
		expect(detail.retryable).toBe(true);
		expect(detail.attempts_log).toEqual([{ attempt: 1, state: 'FAILED', started_at: 10, finished_at: 20, error: 'boom' }]);
	});

	it('Runのノードは試行のエラー本文を含めない', () => {
		const node = {
			id: 'list',
			binding: 'ListNames',
			state: 'COMPLETED',
			container: false,
			parent: null,
			origin: 'static',
			after: [],
			jobId: 'ListNames#0:a',
			childRunId: null,
			result: null,
			error: null,
			position: 0,
			createdAt: 1,
			updatedAt: 2,
			queuedAt: 1,
			runAfter: null,
			startedAt: 2,
			finishedAt: 3,
			attempts: [attempt],
		} satisfies RunNode;
		expect(toRunNode(node).attempts_log).toEqual([{ attempt: 1, state: 'FAILED', started_at: 10, finished_at: 20, error: null }]);
	});
});
