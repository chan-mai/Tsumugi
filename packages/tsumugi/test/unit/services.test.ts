import { describe, expect, it } from 'vitest';
import type { Job, JobListItem } from '../../src/core/entity/job.entity.js';
import type { Run, RunNode } from '../../src/core/entity/run.entity.js';
import type { JobRepository } from '../../src/repository/job.repository.js';
import type { RunRepository } from '../../src/repository/run.repository.js';
import { createBindingService } from '../../src/service/bindings.service.js';
import { createJobService } from '../../src/service/jobs.service.js';
import { createRunService } from '../../src/service/runs.service.js';
import type { ServiceEnv } from '../../src/service/types.js';

const KEEP = 60_000;

const item = (patch: Partial<JobListItem>): JobListItem => ({
	id: 'Hello#0:a',
	binding: 'Hello',
	state: 'FAILED',
	priority: 0,
	attempts: 1,
	maxAttempts: 1,
	createdAt: 0,
	updatedAt: Date.now(),
	dispatchedAt: null,
	...patch,
});

const jobRepository = (patch: Partial<JobRepository>): JobRepository => ({
	list: async () => ({ jobs: [], total: 0 }),
	listBindings: async () => [],
	selectBulkTargets: async () => ({ ids: [], remaining: 0 }),
	stats: async () => ({ byState: {}, oldestScheduledAt: null }),
	find: async () => null,
	...patch,
});

// shard毎にmutateManyの応答を差し替え
const shardEnv = (respond: (shard: string, ids: readonly string[]) => Promise<{ ok: string[]; failed: [] }>) =>
	({
		JOB_SHARD: {
			idFromName: (name: string) => name,
			get: (name: string) => ({ mutateMany: (_action: string, ids: readonly string[]) => respond(name, ids) }),
		},
	}) as unknown as ServiceEnv;

describe('ジョブのservice', () => {
	it('一覧と詳細にbinding毎の保持期間でretryableを付加する', async () => {
		const repository = jobRepository({
			list: async () => ({
				jobs: [item({ id: 'Hello#0:fresh' }), item({ id: 'Hello#0:old', updatedAt: Date.now() - KEEP * 2 }), item({ state: 'COMPLETED' })],
				total: 3,
			}),
			find: async () => ({ ...item({}), attemptsLog: [] }) as unknown as Job,
		});
		const jobs = createJobService({ failedRetentionMs: () => KEEP }, () => repository);
		const env = {} as ServiceEnv;

		const { jobs: listed } = await jobs.list(env, { state: null, binding: null, limit: 20, offset: 0, sort: 'updatedAt', desc: true });
		expect(listed.map((job) => job.retryable)).toEqual([true, false, false]);
		expect((await jobs.detail(env, 'Hello#0:a'))?.retryable).toBe(true);
		expect(await createJobService({}, () => jobRepository({})).detail(env, 'Hello#0:a')).toBeNull();
	});

	it('投入先が未設定ならcreateを持たない', () => {
		expect(createJobService({}, () => jobRepository({})).create).toBeNull();
		expect(createJobService({ enqueue: async () => 'Hello#0:a' }, () => jobRepository({})).create).toBeTypeOf('function');
	});

	it('条件指定の一括操作は対象をrepositoryから取得する', async () => {
		const selected: unknown[] = [];
		const repository = jobRepository({
			selectBulkTargets: async (action, filter, retention) => {
				selected.push({ action, states: filter.states, retained: retention !== undefined });
				return { ids: ['Hello#0:a', 'Hello#1:b'], remaining: 5 };
			},
		});
		const jobs = createJobService({ failedRetentionMs: () => KEEP, bindings: ['Hello'] }, () => repository);
		const env = shardEnv(async (_shard, ids) => ({ ok: [...ids], failed: [] }));

		const result = await jobs.bulk(env, 'retry', { kind: 'filter', states: ['FAILED'], limit: 2 });
		expect(selected).toEqual([{ action: 'retry', states: ['FAILED'], retained: true }]);
		expect(result).toEqual({ ok: ['Hello#0:a', 'Hello#1:b'], failed: [], remaining: 5 });
	});

	it('ID指定の一括操作はrepositoryを参照しない', async () => {
		const repository = jobRepository({
			selectBulkTargets: async () => {
				throw new Error('must not be called');
			},
		});
		const jobs = createJobService({}, () => repository);
		const env = shardEnv(async (_shard, ids) => ({ ok: [...ids], failed: [] }));
		expect(await jobs.bulk(env, 'cancel', { kind: 'ids', ids: ['Hello#0:a'] })).toEqual({ ok: ['Hello#0:a'], failed: [], remaining: 0 });
	});

	it('統計は最古の予約からの経過時間を返す', async () => {
		const now = Date.now();
		const jobs = createJobService({}, () =>
			jobRepository({ stats: async () => ({ byState: { SCHEDULED: 2 }, oldestScheduledAt: now - 1_000 }) }),
		);
		const { byState, oldestScheduledMs } = await jobs.stats({} as ServiceEnv);
		expect(byState).toEqual({ SCHEDULED: 2 });
		expect(oldestScheduledMs).toBeGreaterThanOrEqual(1_000);
		expect((await createJobService({}, () => jobRepository({})).stats({} as ServiceEnv)).oldestScheduledMs).toBeNull();
	});
});

describe('Runのservice', () => {
	const run = (patch: Partial<Run>): Run => ({
		id: 'GREETINGS:a',
		flow: 'GREETINGS',
		state: 'FAILED',
		input: '{}',
		nodeTotal: 1,
		nodeDone: 0,
		nodeFailed: 1,
		createdAt: 0,
		updatedAt: Date.now(),
		parentRunId: null,
		parentNodeId: null,
		...patch,
	});
	const runRepository = (found: Run | null): RunRepository => ({
		list: async () => ({ runs: [], total: 0 }),
		find: async () => (found ? { run: found, nodes: [] as RunNode[] } : null),
	});

	it('詳細に保持期間でretryableを付加する', async () => {
		const env = {} as ServiceEnv;
		const fresh = createRunService({ runFailedRetentionMs: KEEP }, () => runRepository(run({})));
		const old = createRunService({ runFailedRetentionMs: KEEP }, () => runRepository(run({ updatedAt: Date.now() - KEEP * 2 })));
		expect((await fresh.detail(env, 'GREETINGS:a'))?.run.retryable).toBe(true);
		expect((await old.detail(env, 'GREETINGS:a'))?.run.retryable).toBe(false);
		expect(await createRunService({}, () => runRepository(null)).detail(env, 'GREETINGS:a')).toBeNull();
	});

	it('開始と操作が未設定ならstartを持たずunavailableを返す', async () => {
		const runs = createRunService({}, () => runRepository(null));
		expect(runs.start).toBeNull();
		expect(await runs.mutate({} as ServiceEnv, 'GREETINGS:a', 'cancel')).toEqual({ ok: false, reason: 'unavailable' });
	});

	it('不正なRun IDはDOへ送信しない', async () => {
		const runs = createRunService(
			{
				runFor: () => {
					throw new Error('must not be called');
				},
			},
			() => runRepository(null),
		);
		expect(await runs.mutate({} as ServiceEnv, 'not-a-run-id', 'retry')).toEqual({ ok: false, reason: 'invalid-id' });
	});

	it('flowの一覧は名前順', () => {
		expect(createRunService({ flows: ['TIMED', 'BRANCHED'] }, () => runRepository(null)).flows()).toEqual(['BRANCHED', 'TIMED']);
	});
});

describe('bindingのservice', () => {
	it('登録一覧がなければ全bindingを既知とし投影済みの一覧を返す', async () => {
		const service = createBindingService({}, () => ({ listBindings: async () => ['A', 'B'] }));
		expect(service.isKnown('anything')).toBe(true);
		expect(await service.list({} as ServiceEnv)).toEqual(['A', 'B']);
	});

	it('登録一覧があればそれを名前順で返す', async () => {
		const service = createBindingService({ bindings: ['Slow', 'Hello'] }, () => {
			throw new Error('must not be called');
		});
		expect(service.isKnown('Nope')).toBe(false);
		expect(await service.list({} as ServiceEnv)).toEqual(['Hello', 'Slow']);
	});
});
