import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { DispatchMessage } from '../../src/do/job-shard.js';
import type { TsumugiRunInstance } from '../../src/do/run.js';
import type { RunRow } from '../../src/do/run-schema.js';
import { handleBatch, type ConsumerEnv } from '../../src/queue/consumer.js';

// flow定義はexamples/basic, GREETINGSはstart時の期限, TIMEDはflow定義の期限を参照(ADR-0039)
// Job DOの流量を0に制限し、ジョブがSCHEDULEDのまま期限到来する状況を作成

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
// `any`ではTS2589発生、公開型で宣言
const runNamespace = env.RUN as unknown as DurableObjectNamespace<TsumugiRunInstance>;
const runStub = (runId: string) => runNamespace.get(runNamespace.idFromName(runId));

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

// 実キューではconsumer自動実行、作成した状況が破損
async function installQueues(): Promise<void> {
	for (const binding of BINDINGS) {
		await runInDurableObject(shard(binding), (instance) => {
			(instance as any).env.TSUMUGI_QUEUE = queue;
		});
	}
}

// 期限判定はこの時計のみ参照
const setClock = (runId: string, now: number) =>
	runInDurableObject(runStub(runId), (instance) => {
		(instance as any).clock = { now: () => now };
	});

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
	it('期限超過で待機中のノードが中断されrunがFAILEDになる', async () => {
		await installQueues();
		await shard('ListNames').configure({ policy: { concurrency: 0 } });

		const runId = 'GREETINGS:deadline1';
		const stub = runStub(runId);
		await setClock(runId, T0);
		await stub.start({ flow: 'GREETINGS', input: { prefix: 'dl' }, deadlineMs: DEADLINE });
		await settleRun(runId);

		expect(Object.fromEntries(await nodesOf(runId))).toEqual({ list: 'SCHEDULED', greet: 'PENDING', report: 'PENDING' });
		// 停滞runの超過判定用に期限時刻へalarm設定
		expect(await runInDurableObject(stub, (instance) => (instance as any).ctx.storage.getAlarm())).toBe(T0 + DEADLINE);

		await setClock(runId, T0 + DEADLINE);
		await runDurableObjectAlarm(stub);
		await settleRun(runId);

		expect(Object.fromEntries(await nodesOf(runId))).toEqual({ list: 'FAILED', greet: 'FAILED', report: 'FAILED' });
		expect(await stateOf(runId)).toBe('FAILED');
		expect(await nodeErrorOf(runId, 'list')).toBe(`run deadline exceeded: ${DEADLINE}ms`);

		const jobId = await jobIdOf(runId, 'list');
		if (jobId === null) throw new Error('the first node has no job id');
		const jobState = await runInDurableObject(shard('ListNames'), (instance) => (instance as any).repo.find(jobId)?.state as string);
		expect(jobState).toBe('CANCELLED');
	});

	it('実行中のジョブは取り消さず終端を待ってからFAILEDになる', async () => {
		await installQueues();
		// 前テストの流量制限を明示的に解除
		await shard('ListNames').configure({ policy: { concurrency: 100 } });
		const runId = 'GREETINGS:deadline2';
		const stub = runStub(runId);
		await setClock(runId, T0);
		await stub.start({ flow: 'GREETINGS', input: { prefix: 'dl2' }, deadlineMs: DEADLINE });
		await settleRun(runId);

		const jobId = await jobIdOf(runId, 'list');
		if (jobId === null) throw new Error('the first node has no job id');

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

		// QUEUED以降は取り消し不可(ADR-0012), 終端通知までrunはRUNNING
		expect(Object.fromEntries(await nodesOf(runId))).toEqual({ list: 'SCHEDULED', greet: 'FAILED', report: 'FAILED' });
		expect(await stateOf(runId)).toBe('RUNNING');

		await stub.notify([{ nodeId: 'list', jobId, state: 'COMPLETED', result: JSON.stringify({ names: ['x'] }), error: null }]);
		await settleRun(runId);

		expect(Object.fromEntries(await nodesOf(runId))).toEqual({ list: 'COMPLETED', greet: 'FAILED', report: 'FAILED' });
		expect(await stateOf(runId)).toBe('FAILED');
	});

	it('再開で期限が再計算される(ADR-0034)', async () => {
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

		await shard('ListNames').configure({ policy: { concurrency: 100 } });
		await setClock(runId, T0 + 60_000);
		expect(await stub.retry()).toEqual({ ok: true });

		const row = await runRowOf(runId);
		expect(row?.deadline_ms).toBe(DEADLINE);
		expect(row?.deadline_at).toBe(T0 + 60_000 + DEADLINE);
		// 超過フラグ残存時は再開直後に再びFAILED
		expect(row?.expired).toBe(0);

		await settleRun(runId);
		expect(await runInDurableObject(stub, (instance) => (instance as any).ctx.storage.getAlarm())).toBe(T0 + 60_000 + DEADLINE);

		await settle(runId);
		expect(await stateOf(runId)).toBe('COMPLETED');
	});

	it('再開で期限超過により中断したfan-outの子を実行し集計し直す', async () => {
		await installQueues();
		await shard('ListNames').configure({ policy: { concurrency: 100 } });
		await shard('Greet').configure({ policy: { concurrency: 0 } });

		const runId = 'GREETINGS:deadline-fanout';
		const stub = runStub(runId);
		await setClock(runId, T0);
		await stub.start({ flow: 'GREETINGS', input: { prefix: 'df' }, deadlineMs: DEADLINE });
		await settle(runId);
		expect(Object.fromEntries(await nodesOf(runId))).toMatchObject({ greet: 'RUNNING', 'greet:0': 'SCHEDULED' });

		await setClock(runId, T0 + DEADLINE);
		await runDurableObjectAlarm(stub);
		await settleRun(runId);
		expect(Object.fromEntries(await nodesOf(runId))).toMatchObject({ greet: 'COMPLETED', 'greet:0': 'FAILED', report: 'FAILED' });
		expect(await stateOf(runId)).toBe('FAILED');

		await shard('Greet').configure({ policy: { concurrency: 100 } });
		await setClock(runId, T0 + 60_000);
		expect(await stub.retry()).toEqual({ ok: true });
		expect(Object.fromEntries(await nodesOf(runId))).toMatchObject({ greet: 'RUNNING', 'greet:0': 'PENDING', report: 'PENDING' });

		performed.length = 0;
		await settle(runId);
		expect(await stateOf(runId)).toBe('COMPLETED');
		expect(performed.find((p) => p.binding === 'Report')?.payload).toEqual({ total: 1, failed: 0 });
	});

	it('期限前に完了したrunは超過後のtickで反転しない', async () => {
		await installQueues();
		await shard('ListNames').configure({ policy: { concurrency: 100 } });
		const runId = 'GREETINGS:done-in-time';
		const stub = runStub(runId);
		await setClock(runId, T0);
		await stub.start({ flow: 'GREETINGS', input: { prefix: 'ok' }, deadlineMs: DEADLINE });
		await settle(runId);
		expect(await stateOf(runId)).toBe('COMPLETED');

		// 削除tickは期限後に実行, 決着済みrunはFAILEDへ遷移なし
		await setClock(runId, T0 + DEADLINE + 1);
		await runDurableObjectAlarm(stub);
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

		// RPC越し例外はvitest-pool-workersで未処理rejection扱い、DO内で実行
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
		// 親の中断と子の取り消しは複数tickで進行、交互発火で決着
		for (let i = 0; i < 6; i++) {
			await runDurableObjectAlarm(stub);
			await runDurableObjectAlarm(runStub(childId));
		}

		expect(await stateOf(childId)).toBe('CANCELLED');
		expect(await stateOf(parentId)).toBe('FAILED');
		expect(Object.fromEntries(await nodesOf(parentId))).toEqual({ greetings: 'CANCELLED', summary: 'FAILED' });
	});
});
