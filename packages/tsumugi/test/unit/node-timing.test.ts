import { describe, expect, it } from 'vitest';
import { nodeTiming } from '../../src/core/node-timing.js';

const job = (state: string) => ({ state, createdAt: 100, runAfter: 150, dispatchedAt: 200, updatedAt: 500 });

describe('ノードの時刻', () => {
	it('ジョブを持つノードはジョブ行の時刻', () => {
		expect(nodeTiming(job('COMPLETED'), null)).toEqual({ queuedAt: 100, runAfter: 150, startedAt: 200, finishedAt: 500 });
	});

	it('実行中のジョブは終了時刻なし', () => {
		for (const state of ['SCHEDULED', 'QUEUED', 'RUNNING']) {
			expect(nodeTiming(job(state), null).finishedAt, state).toBeNull();
		}
	});

	it('subflowは子runの作成から終端まで', () => {
		expect(nodeTiming(null, { state: 'COMPLETED', createdAt: 400, updatedAt: 750 })).toEqual({
			queuedAt: 400,
			runAfter: null,
			startedAt: 400,
			finishedAt: 750,
		});
		expect(nodeTiming(null, { state: 'RUNNING', createdAt: 400, updatedAt: 750 }).finishedAt).toBeNull();
	});

	it('ジョブも子runもないノードは全てnull', () => {
		expect(nodeTiming(null, null)).toEqual({ queuedAt: null, runAfter: null, startedAt: null, finishedAt: null });
	});
});
