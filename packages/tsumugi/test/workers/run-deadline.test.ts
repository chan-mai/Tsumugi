import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { DispatchMessage } from '../../src/do/job-shard.js';
import type { TsumugiRunInstance } from '../../src/do/run.js';
import type { RunRow } from '../../src/do/run-schema.js';
import { handleBatch, type ConsumerEnv } from '../../src/queue/consumer.js';

/**
 * run全体の期限(ADR-0039)
 *
 * flowの定義はexamples/basicが持つ, GREETINGSはstart時の期限, TIMEDはflow定義の期限を見る
 * Job DOの流量を0に絞ることで, ジョブがSCHEDULEDのまま期限を迎える状況を作る
 */

const performed: { binding: string; payload: unknown }[] = [];

const performers = {
	ListNames: {
		perform: async (payload: { prefix: string }) => {
			performed.push({ binding: 'ListNames', payload });
			return { names: [`${payload.prefix}-1`] };
		},
	},
	Greet: {
		perform: async (payload: { name: string }) => {
			performed.push({ binding: 'Greet', payload });
			return { greeted: payload.name };
		},
	},
	Report: {
		perform: async (payload: { total: number; failed: number }): Promise<void> => {
			performed.push({ binding: 'Report', payload });
		},
	},
};
const BINDINGS = ['ListNames', 'Greet', 'Report'] as const;

const T0 = 2_400_000_000_000;
const DEADLINE = 10_000;

const consumerEnv: ConsumerEnv = env;

const shard = (binding: string) => env.JOB_SHARD.get(env.JOB_SHARD.idFromName(`${binding}#0`));
// `any`のまま持つと型の展開が深くなりTS2589に触れる, 公開している面で受ける
const runNamespace = env.RUN as unknown as DurableObjectNamespace<TsumugiRunInstance>;
const runStub = (runId: string) => runNamespace.get(runNamespace.idFromName(runId));

/** DOが送ったメッセージを溜めてconsumerへ手で渡す, Queuesの配送自体はここでの関心ではない */
const sent: DispatchMessage[] = [];
const queue = {
	send: async (body: DispatchMessage) => {
		sent.push(body);
	},
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

/** Job DOの投入先を差し替える, 実キューへ出すとconsumerが自動で走り手で作った状況が壊れる */
async function installQueues(): Promise<void> {
	for (const binding of BINDINGS) {
		await runInDurableObject(shard(binding), (instance) => {
			(instance as any).env.TSUMUGI_QUEUE = queue;
		});
	}
}

/** Run DOの時計を固定する, 期限の判定はこの時計だけを読む */
const setClock = (runId: string, now: number) =>
	runInDurableObject(runStub(runId), (instance) => {
		(instance as any).clock = { now: () => now };
	});

/** Job DOとRun DOのalarmを交互に発火させ, 進みが止まるまで回す */
async function settle(runId: string, rounds = 14): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		await installQueues();
		for (const binding of BINDINGS) {
			await runDurableObjectAlarm(shard(binding));
		}
		if (sent.length > 0) {
			const batch = makeBatch([...sent]);
			sent.length = 0;
			await handleBatch(batch, consumerEnv, performers);
		}
		await runDurableObjectAlarm(runStub(runId));
	}
}

/** ノードの状態が変わらなくなるまでtickを回す */
async function settleRun(runId: string, rounds = 8): Promise<void> {
	let previous = '';
	for (let i = 0; i < rounds; i++) {
		const current = JSON.stringify(await nodesOf(runId));
		if (current === previous) return;
		previous = current;
		await runDurableObjectAlarm(runStub(runId));
	}
	throw new Error(`node states did not settle within ${rounds} ticks`);
}

const nodesOf = (runId: string) =>
	runInDurableObject(runStub(runId), (instance) =>
		((instance as any).repo.views() as { id: string; state: string }[]).map((node) => [node.id, node.state] as const),
	);

const stateOf = (runId: string) =>
	runInDurableObject(runStub(runId), (instance) => (instance as any).repo.findRun()?.state as string | undefined);

const runRowOf = (runId: string) =>
	runInDurableObject(runStub(runId), (instance) => (instance as any).repo.findRun() as RunRow | undefined);

const jobIdOf = (runId: string, nodeId: string) =>
	runInDurableObject(runStub(runId), (instance) => (instance as any).repo.findNode(nodeId)?.job_id as string | null);

const nodeErrorOf = (runId: string, nodeId: string) =>
	runInDurableObject(runStub(runId), (instance) => (instance as any).repo.findNode(nodeId)?.error as string | null);

describe('run全体の期限(ADR-0039)', () => {
	it('期限超過で待機中のノードが打ち切られrunがFAILEDになる', async () => {
		await installQueues();
		// 流量を0に絞る, ジョブがSCHEDULEDのまま動かない状況を作る
		await shard('ListNames').configure({ policy: { concurrency: 0 } });

		const runId = 'GREETINGS:deadline1';
		const stub = runStub(runId);
		await setClock(runId, T0);
		await stub.start({ flow: 'GREETINGS', input: { prefix: 'dl' }, deadlineMs: DEADLINE });
		await settleRun(runId);

		expect(Object.fromEntries(await nodesOf(runId))).toEqual({ list: 'SCHEDULED', greet: 'PENDING', report: 'PENDING' });
		// 静かなrunでも超過を判定できるよう, 期限の時刻にalarmが張られる
		expect(await runInDurableObject(stub, (instance) => (instance as any).ctx.storage.getAlarm())).toBe(T0 + DEADLINE);

		await setClock(runId, T0 + DEADLINE);
		await runDurableObjectAlarm(stub);
		await settleRun(runId);

		expect(Object.fromEntries(await nodesOf(runId))).toEqual({ list: 'FAILED', greet: 'FAILED', report: 'FAILED' });
		expect(await stateOf(runId)).toBe('FAILED');
		expect(await nodeErrorOf(runId, 'list')).toBe(`run deadline exceeded: ${DEADLINE}ms`);

		// Job DO側の投入済みジョブも取り消されている
		const jobId = await jobIdOf(runId, 'list');
		if (jobId === null) throw new Error('the first node has no job id');
		const jobState = await runInDurableObject(shard('ListNames'), (instance) => (instance as any).repo.find(jobId)?.state as string);
		expect(jobState).toBe('CANCELLED');
	});

	it('実行中のジョブは取り消さず終端を待ってからFAILEDになる', async () => {
		await installQueues();
		// 前のテストの流量制限が残らないよう明示的に戻す
		await shard('ListNames').configure({ policy: { concurrency: 100 } });
		const runId = 'GREETINGS:deadline2';
		const stub = runStub(runId);
		await setClock(runId, T0);
		await stub.start({ flow: 'GREETINGS', input: { prefix: 'dl2' }, deadlineMs: DEADLINE });
		await settleRun(runId);

		const jobId = await jobIdOf(runId, 'list');
		if (jobId === null) throw new Error('the first node has no job id');

		// 投入まで進めてQUEUEDにする, メッセージは配送しない
		const jobStateOf = () =>
			runInDurableObject(shard('ListNames'), (instance) => (instance as any).repo.find(jobId)?.state as string | undefined);
		for (let i = 0; i < 5 && (await jobStateOf()) === 'SCHEDULED'; i++) {
			await runDurableObjectAlarm(shard('ListNames'));
		}
		expect(await jobStateOf()).toBe('QUEUED');
		sent.length = 0;

		await setClock(runId, T0 + DEADLINE + 1);
		await runDurableObjectAlarm(stub);
		await settleRun(runId);

		// QUEUED以降の取り消しは断られる(ADR-0012), 終端が届くまでrunはRUNNINGのまま
		expect(Object.fromEntries(await nodesOf(runId))).toEqual({ list: 'SCHEDULED', greet: 'FAILED', report: 'FAILED' });
		expect(await stateOf(runId)).toBe('RUNNING');

		await stub.notify([{ nodeId: 'list', jobId, state: 'COMPLETED', result: JSON.stringify({ names: ['x'] }), error: null }]);
		await settleRun(runId);

		expect(Object.fromEntries(await nodesOf(runId))).toEqual({ list: 'COMPLETED', greet: 'FAILED', report: 'FAILED' });
		expect(await stateOf(runId)).toBe('FAILED');
	});

	it('再開で期限が引き直される(ADR-0034)', async () => {
		await installQueues();
		await shard('ListNames').configure({ policy: { concurrency: 0 } });

		const runId = 'GREETINGS:deadline3';
		const stub = runStub(runId);
		await setClock(runId, T0);
		await stub.start({ flow: 'GREETINGS', input: { prefix: 'dl3' }, deadlineMs: DEADLINE });
		await settleRun(runId);
		await setClock(runId, T0 + DEADLINE);
		await runDurableObjectAlarm(stub);
		await settleRun(runId);
		expect(await stateOf(runId)).toBe('FAILED');

		// 詰まりを解消してから再開する
		await shard('ListNames').configure({ policy: { concurrency: 100 } });
		await setClock(runId, T0 + 60_000);
		expect(await stub.retry()).toEqual({ ok: true });

		const row = await runRowOf(runId);
		expect(row?.deadline_ms).toBe(DEADLINE);
		expect(row?.deadline_at).toBe(T0 + 60_000 + DEADLINE);

		await settle(runId);
		expect(await stateOf(runId)).toBe('COMPLETED');
	});

	it('期限はflow定義を既定としstartの指定が優先される', async () => {
		await installQueues();
		const byFlow = 'TIMED:flow-default';
		await setClock(byFlow, T0);
		await runStub(byFlow).start({ flow: 'TIMED', input: { prefix: 'fd' } });
		const defaulted = await runRowOf(byFlow);
		expect(defaulted?.deadline_ms).toBe(10 * 60 * 1000);
		expect(defaulted?.deadline_at).toBe(T0 + 10 * 60 * 1000);

		const byStart = 'TIMED:override';
		await setClock(byStart, T0);
		await runStub(byStart).start({ flow: 'TIMED', input: { prefix: 'ov' }, deadlineMs: 5_000 });
		const overridden = await runRowOf(byStart);
		expect(overridden?.deadline_ms).toBe(5_000);
		expect(overridden?.deadline_at).toBe(T0 + 5_000);

		// 正の整数でない期限は開始ごと弾く
		// RPC越しの例外はvitest-pool-workersが未処理rejectionとして報告するためDO内で実行
		await expect(
			runInDurableObject(runStub('TIMED:invalid'), (instance) =>
				(instance as any).start({ flow: 'TIMED', input: { prefix: 'ng' }, deadlineMs: 0 }),
			),
		).rejects.toThrow('deadlineMs must be a positive integer');
	});

	it('親の期限超過で実行中の子のrunが取り消される', async () => {
		await installQueues();
		await shard('ListNames').configure({ policy: { concurrency: 0 } });

		const parentId = 'PIPELINE:deadline-sub';
		const childId = 'GREETINGS:deadline-sub-greetings';
		const stub = runStub(parentId);
		await setClock(parentId, T0);
		await stub.start({ flow: 'PIPELINE', input: { prefix: 'sub' }, deadlineMs: DEADLINE });
		await settleRun(parentId);
		await settleRun(childId);
		expect(await stateOf(childId)).toBe('RUNNING');

		await setClock(parentId, T0 + DEADLINE);
		// 親の打ち切りと子の取り消しはtickを跨いで進む, 交互に発火させて決着させる
		for (let i = 0; i < 6; i++) {
			await runDurableObjectAlarm(stub);
			await runDurableObjectAlarm(runStub(childId));
		}

		expect(await stateOf(childId)).toBe('CANCELLED');
		expect(await stateOf(parentId)).toBe('FAILED');
		expect(Object.fromEntries(await nodesOf(parentId))).toEqual({ greetings: 'CANCELLED', summary: 'FAILED' });
	});
});
