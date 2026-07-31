import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { DispatchMessage } from '../../src/do/job-shard.js';
import type { TsumugiRunInstance } from '../../src/do/run.js';
import { handleBatch, type ConsumerEnv } from '../../src/queue/consumer.js';

/**
 * 縦串: 親のrunが子のrunを起動して待つ
 *
 * flowの定義はexamples/basicが持つ(PIPELINEがGREETINGSを起動する)
 */

// consumerへ渡すのは`perform`を持つ実体, `ctx.exports`から引かれる形と同じ(ADR-0037)
const ListNames = {
	perform: async (payload: { prefix: string }) => ({ names: [`${payload.prefix}-1`, `${payload.prefix}-2`] }),
};

const Greet = {
	perform: async (payload: { name: string }) => ({ greeted: payload.name }),
};

const Report = {
	perform: async (): Promise<void> => {},
};

const BINDINGS = ['ListNames', 'Greet', 'Report'] as const;
const consumerEnv: ConsumerEnv = env;

const shard = (binding: string) => env.JOB_SHARD.get(env.JOB_SHARD.idFromName(`${binding}#0`));
const runNamespace = env.RUN as unknown as DurableObjectNamespace<TsumugiRunInstance>;
const runStub = (runId: string) => runNamespace.get(runNamespace.idFromName(runId));

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

/** 親と子のRun DOとJob DOを交互に発火させ, 進みが止まるまで回す */
async function settle(runIds: string[], performers: Record<string, unknown>, rounds = 16): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		for (const binding of BINDINGS) {
			await runInDurableObject(shard(binding), (instance) => {
				(instance as any).env.TSUMUGI_QUEUE = queue;
			});
			await runDurableObjectAlarm(shard(binding));
		}
		if (sent.length > 0) {
			const batch = makeBatch([...sent]);
			sent.length = 0;
			await handleBatch(batch, consumerEnv, performers as never);
		}
		for (const runId of runIds) await runDurableObjectAlarm(runStub(runId));
	}
}

const stateOf = (runId: string) => runInDurableObject(runStub(runId), (instance) => (instance as any).repo.findRun()?.state as string);
const nodeOf = (runId: string, nodeId: string) => runInDurableObject(runStub(runId), (instance) => (instance as any).repo.findNode(nodeId));
const nodesOf = (runId: string) =>
	runInDurableObject(runStub(runId), (instance) =>
		((instance as any).repo.views() as { id: string; state: string }[]).map((node) => [node.id, node.state] as const),
	);

/**
 * Run DOのalarmだけを, ノードの状態が変わらなくなるまで発火させる
 * performerを実行しないので投入までで止まる, ラウンド数で状況を作ると進みすぎる場合がある
 */
async function settleRuns(runIds: string[], rounds = 8): Promise<void> {
	let previous = '';
	for (let i = 0; i < rounds; i++) {
		const current = JSON.stringify(await Promise.all(runIds.map((runId) => nodesOf(runId))));
		if (current === previous) return;
		previous = current;
		for (const runId of runIds) await runDurableObjectAlarm(runStub(runId));
	}
	throw new Error(`node states did not settle within ${rounds} ticks`);
}

describe('subflowの縦串', () => {
	const registry = { ListNames, Greet, Report };

	it('子のrunを起動し, その終端を待って後段へ進む', async () => {
		const parent = 'PIPELINE:sub-ok';
		const child = 'GREETINGS:sub-ok-greetings';
		await runStub(parent).start({ flow: 'PIPELINE', input: { prefix: 'hello' } });
		await settle([parent, child], registry);

		expect(await stateOf(child)).toBe('COMPLETED');
		expect((await nodeOf(parent, 'greetings'))?.state).toBe('COMPLETED');
		// 子の終端を待ってから後段が動く
		expect((await nodeOf(parent, 'summary'))?.state).toBe('COMPLETED');
		expect(await stateOf(parent)).toBe('COMPLETED');
	});

	it('子のrunIdが親のrunIdとノードIDから決まる', async () => {
		const parent = 'PIPELINE:sub-id';
		await runStub(parent).start({ flow: 'PIPELINE', input: { prefix: 'x' } });
		await settle([parent, 'GREETINGS:sub-id-greetings'], registry, 2);

		expect((await nodeOf(parent, 'greetings'))?.child_run_id).toBe('GREETINGS:sub-id-greetings');
	});

	it('子が失敗すると親のノードも失敗し下流を打ち切る', async () => {
		const parent = 'PIPELINE:sub-fail';
		const child = 'GREETINGS:sub-fail-greetings';
		await runStub(parent).start({ flow: 'PIPELINE', input: { prefix: 'x' } });
		// 子の先頭ノードを投入まで進めてから, 失敗の通知だけを手で届ける
		await settleRuns([parent, child]);
		// 投入されたメッセージは配送しない, 実行されると完了報告が返る
		sent.length = 0;
		const jobId = (await nodeOf(child, 'list'))?.job_id;
		if (!jobId) throw new Error('the first node of the child run has no job id');
		await runStub(child).notify([{ nodeId: 'list', jobId, state: 'FAILED', result: null, error: 'intentional failure' }]);
		await settleRuns([parent, child]);

		expect(await stateOf(child)).toBe('FAILED');
		expect((await nodeOf(parent, 'greetings'))?.state).toBe('FAILED');
		expect((await nodeOf(parent, 'summary'))?.state).toBe('SKIPPED');
		expect(await stateOf(parent)).toBe('FAILED');
	});

	it('親を取り消すと子も取り消される', async () => {
		const parent = 'PIPELINE:sub-cancel';
		const child = 'GREETINGS:sub-cancel-greetings';
		await runStub(parent).start({ flow: 'PIPELINE', input: { prefix: 'x' } });
		// 子が動き出すところまで進めてから取り消す
		await settle([parent, child], registry, 2);
		expect(await stateOf(child)).toBe('RUNNING');

		await runStub(parent).cancel();
		await settle([parent, child], registry);

		expect(await stateOf(child)).toBe('CANCELLED');
		expect(await stateOf(parent)).toBe('CANCELLED');
	});

	it('入れ子の上限を超える起動を弾く', async () => {
		// 既定は3, 深さの判定は起動された側が行う
		// RPC越しの例外はvitest-pool-workersが未処理rejectionとして報告するためDO内で実行
		await expect(
			runInDurableObject(runStub('GREETINGS:too-deep'), (instance) =>
				(instance as any).start({ flow: 'GREETINGS', input: { prefix: 'x' }, depth: 4 }),
			),
		).rejects.toThrow('subflow nesting exceeded the limit');
	});

	it('子のrunが親を覚えている', async () => {
		const parent = 'PIPELINE:sub-parent';
		const child = 'GREETINGS:sub-parent-greetings';
		await runStub(parent).start({ flow: 'PIPELINE', input: { prefix: 'x' } });
		await settle([parent, child], registry, 2);

		const row = await runInDurableObject(runStub(child), (instance) => (instance as any).repo.findRun());
		expect(row.parent_run_id).toBe(parent);
		expect(row.parent_node_id).toBe('greetings');
		expect(row.depth).toBe(1);
	});
});
