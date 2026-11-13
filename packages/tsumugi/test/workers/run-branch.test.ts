import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { handleBatch } from '../../src/queue/consumer.js';

import type { NodeEvent } from '../../src/core/run.js';
import type { DispatchMessage } from '../../src/do/job-shard.js';
import type { JobRepo } from '../../src/do/repo.js';
import type { RunRepo } from '../../src/do/run-repo.js';
import type { TsumugiRunInstance } from '../../src/do/run.js';
import type { ConsumerEnv } from '../../src/queue/consumer.js';

// flow定義はexamples/basic(BRANCHED), Run DOが参照(ADR-0030, ADR-0041)
// cleanupはtrigger=failure, auditはtrigger=always, detailはwhenで経路選択

// DO型直接参照でTS2589発生, 使用メソッドのみ宣言
interface RunFace extends Rpc.DurableObjectBranded {
	start(input: { flow: string; input: unknown }): Promise<{ id: string; created: boolean }>;
	notify(events: readonly NodeEvent[]): Promise<void>;
	retry(): Promise<{ ok: boolean }>;
}

type RunInternals = TsumugiRunInstance & {
	ctx: DurableObjectState;
	repo: RunRepo;
};

const runInternals = (instance: unknown) => instance as RunInternals;

const namespace = env.RUN as unknown as DurableObjectNamespace<RunFace>;
const runStub = (runId: string) => namespace.get(namespace.idFromName(runId));
const shard = (binding: string) => env.JOB_SHARD.get(env.JOB_SHARD.idFromName(`${binding}#0`));

const consumerEnv: ConsumerEnv = env;
const BINDINGS = ['ListNames', 'Report'] as const;

const performers = {
	ListNames: { perform: async (payload: { prefix: string }) => ({ names: [`${payload.prefix}-1`] }) },
	Report: { perform: async (_payload: { total: number; failed: number }): Promise<void> => {} },
};

const sent: DispatchMessage[] = [];
const queue = {
	send: async (body: DispatchMessage) => void sent.push(body),
	sendBatch: async (batch: Iterable<{ body: DispatchMessage }>) => {
		for (const m of batch) sent.push(m.body);
	},
};

function makeBatch(bodies: DispatchMessage[]) {
	const messages = bodies.map((body, i) => ({
		id: String(i),
		timestamp: new Date(0),
		body,
		attempts: 1,
		ack: () => {},
		retry: () => {
			throw new Error('consumer must not call retry (ADR-0004)');
		},
	}));
	return { queue: 'test', messages, ackAll: () => {}, retryAll: () => {} } as unknown as MessageBatch<DispatchMessage>;
}

async function installQueues(): Promise<void> {
	for (const binding of BINDINGS) {
		await runInDurableObject(shard(binding), instance => {
			(instance as unknown as { env: { TSUMUGI_QUEUE: unknown } }).env.TSUMUGI_QUEUE = queue;
		});
	}
}

async function settle(runId: string): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await installQueues();
		for (const binding of BINDINGS) await runDurableObjectAlarm(shard(binding));
		if (sent.length > 0) {
			const batch = makeBatch([...sent]);
			sent.length = 0;
			await handleBatch(batch, consumerEnv, performers);
		}
		await runDurableObjectAlarm(runStub(runId));
	}
}

const nodesOf = (runId: string) =>
	runInDurableObject(runStub(runId), instance =>
		Object.fromEntries(
			runInternals(instance)
				.repo.views()
				.map(node => [node.id, node.state]),
		),
	);

const errorOf = (runId: string, nodeId: string) =>
	runInDurableObject(runStub(runId), instance => runInternals(instance).repo.findNode(nodeId)?.error as string | null);

const stateOf = (runId: string) => runInDurableObject(runStub(runId), instance => runInternals(instance).repo.findRun()?.state);

const jobIdOf = (runId: string, nodeId: string) =>
	runInDurableObject(runStub(runId), instance => runInternals(instance).repo.findNode(nodeId)?.job_id as string | null);

async function settleRun(runId: string): Promise<void> {
	let previous = '';
	for (let i = 0; i < 8; i++) {
		const current = JSON.stringify(await nodesOf(runId));
		if (current === previous) return;
		previous = current;
		await runDurableObjectAlarm(runStub(runId));
	}
}

describe('条件分岐と失敗時の継続(ADR-0041)', () => {
	it('成功時は後処理を省略しwhenで経路を選ぶ', async () => {
		const runId = 'BRANCHED:ok';
		await installQueues();
		await runStub(runId).start({ flow: 'BRANCHED', input: { prefix: 'ok', verbose: true } });
		await settle(runId);

		expect(await nodesOf(runId)).toEqual({
			list: 'COMPLETED',
			cleanup: 'SKIPPED',
			detail: 'COMPLETED',
			audit: 'COMPLETED',
		});
		// 状態のみでは判別不能、省略理由を記録
		expect(await errorOf(runId, 'cleanup')).toBe('no dependency failed');
		expect(await stateOf(runId)).toBe('COMPLETED');
	});

	it('whenがfalseなら実行せず理由を残す', async () => {
		const runId = 'BRANCHED:quiet';
		await installQueues();
		await runStub(runId).start({ flow: 'BRANCHED', input: { prefix: 'q', verbose: false } });
		await settle(runId);

		const nodes = await nodesOf(runId);
		expect(nodes['detail']).toBe('SKIPPED');
		expect(nodes['audit']).toBe('COMPLETED');
		expect(await errorOf(runId, 'detail')).toBe('when returned false');
		expect(await stateOf(runId)).toBe('COMPLETED');
	});

	it('記録済みジョブIDを持つノードはwhenを再評価しない', async () => {
		const runId = 'BRANCHED:when-reserved';
		const jobId = 'Report#0:whenreserved';
		await installQueues();
		await runInDurableObject(runStub(runId), async instance => {
			const inner = runInternals(instance);
			await inner.start({ flow: 'BRANCHED', input: { prefix: 'wr', verbose: false } });
			await inner.ctx.storage.deleteAlarm();
			inner.repo.updateNode(
				'list',
				{ state: 'COMPLETED', result: JSON.stringify({ names: ['wr-1'] }) },
				Temporal.Now.instant().epochMilliseconds,
			);
			inner.repo.updateNode('detail', { jobId }, Temporal.Now.instant().epochMilliseconds);
			await inner.ctx.storage.setAlarm(Temporal.Now.instant().epochMilliseconds);
		});
		await runDurableObjectAlarm(runStub(runId));
		await settleRun(runId);

		expect((await nodesOf(runId))['detail']).not.toBe('SKIPPED');
		expect(await jobIdOf(runId, 'detail')).toBe(jobId);
		const job = await runInDurableObject(shard('Report'), instance => (instance as unknown as { repo: JobRepo }).repo.find(jobId));
		expect(job?.id).toBe(jobId);
	});

	it('上流が失敗すると後始末が通りrunはFAILEDのまま', async () => {
		const runId = 'BRANCHED:ng';
		const stub = runStub(runId);
		await installQueues();
		await stub.start({ flow: 'BRANCHED', input: { prefix: 'ng', verbose: true } });

		await settleRun(runId);
		await runDurableObjectAlarm(shard('ListNames'));
		sent.length = 0;
		const jobId = await jobIdOf(runId, 'list');
		if (jobId === null) throw new Error('the first node has no job id');
		await stub.notify([{ nodeId: 'list', jobId, state: 'FAILED', result: null, error: 'intentional failure' }]);
		await settle(runId);

		expect(await nodesOf(runId)).toEqual({
			list: 'FAILED',
			cleanup: 'COMPLETED',
			audit: 'COMPLETED',
			detail: 'SKIPPED',
		});
		expect(await errorOf(runId, 'detail')).toBe('a dependency did not succeed');
		expect(await stateOf(runId)).toBe('FAILED');
	});

	it('失敗したrunの再開で後始末と監査を再実行する', async () => {
		const runId = 'BRANCHED:retry-ng';
		const stub = runStub(runId);
		await installQueues();
		await stub.start({ flow: 'BRANCHED', input: { prefix: 'rn', verbose: true } });
		await failList(runId);
		const cleanup = await jobIdOf(runId, 'cleanup');
		const audit = await jobIdOf(runId, 'audit');

		expect(await stub.retry()).toEqual({ ok: true });
		expect(await nodesOf(runId)).toEqual({ list: 'PENDING', cleanup: 'PENDING', audit: 'PENDING', detail: 'PENDING' });

		await failList(runId);
		expect(await nodesOf(runId)).toEqual({ list: 'FAILED', cleanup: 'COMPLETED', audit: 'COMPLETED', detail: 'SKIPPED' });
		expect(await jobIdOf(runId, 'cleanup')).not.toBe(cleanup);
		expect(await jobIdOf(runId, 'audit')).not.toBe(audit);
		expect(await stateOf(runId)).toBe('FAILED');
	});

	it('再開で子を持つfan-outのノードはCOMPLETEDのまま残る', async () => {
		const runId = 'GREETINGS:retry-container';
		await runInDurableObject(runStub(runId), async instance => {
			const inner = runInternals(instance);
			await inner.start({ flow: 'GREETINGS', input: { prefix: 'rc' } });
			await inner.ctx.storage.deleteAlarm();
			const now = Temporal.Now.instant().epochMilliseconds;
			inner.repo.insertNodes(
				[{ id: 'greet:0', binding: 'Greet', container: false, parent: 'greet', origin: 'fanOut', after: [], seq: 3 }],
				now,
			);
			inner.repo.updateNode('list', { state: 'FAILED' }, now);
			inner.repo.updateNode('greet', { state: 'COMPLETED' }, now);
			inner.repo.updateNode('greet:0', { state: 'COMPLETED' }, now);
			inner.repo.updateNode('report', { state: 'COMPLETED' }, now);
			inner.repo.setRunState(runId, 'FAILED', now);
			expect(await inner.retry()).toEqual({ ok: true });
			await inner.ctx.storage.deleteAlarm();
		});

		expect(await nodesOf(runId)).toEqual({ list: 'PENDING', greet: 'COMPLETED', 'greet:0': 'COMPLETED', report: 'COMPLETED' });
	});
});

async function failList(runId: string): Promise<void> {
	await settleRun(runId);
	await runDurableObjectAlarm(shard('ListNames'));
	sent.length = 0;
	const jobId = await jobIdOf(runId, 'list');
	if (jobId === null) throw new Error('the first node has no job id');
	await runStub(runId).notify([{ nodeId: 'list', jobId, state: 'FAILED', result: null, error: 'intentional failure' }]);
	await settle(runId);
}
