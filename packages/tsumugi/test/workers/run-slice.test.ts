import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { JobContext } from '../../src/core/api.js';
import type { DispatchMessage } from '../../src/do/job-shard.js';
import type { TsumugiRunInstance } from '../../src/do/run.js';
import { handleBatch, type ConsumerEnv } from '../../src/queue/consumer.js';

// flow定義はexamples/basic(GREETINGS), Run DOが参照(ADR-0030)

const performed: { binding: string; payload: unknown }[] = [];

const listNames = {
	perform: async (payload: { prefix: string }) => {
		performed.push({ binding: 'ListNames', payload });
		return { names: [`${payload.prefix}-1`, `${payload.prefix}-2`, `${payload.prefix}-3`] };
	},
};

const greet = {
	perform: async (payload: { name: string }) => {
		performed.push({ binding: 'Greet', payload });
		return { greeted: payload.name };
	},
};

const report = {
	perform: async (payload: { total: number; failed: number }): Promise<void> => {
		performed.push({ binding: 'Report', payload });
	},
};

const greetAndSpawn = {
	perform: async (payload: { name: string }, ctx: JobContext) => {
		performed.push({ binding: 'Greet', payload });
		// 無限増加防止、`-child`付きは孫作成なし
		if (!payload.name.endsWith('-child')) ctx.spawn('child', 'Greet', { name: `${payload.name}-child` });
		return { greeted: payload.name };
	},
};

const performers = { ListNames: listNames, Greet: greet, Report: report };
const spawningPerformers = { ListNames: listNames, Greet: greetAndSpawn, Report: report };
const BINDINGS = ['ListNames', 'Greet', 'Report'] as const;

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

// 実キューではconsumer自動実行、完了通知の割り込みで作成した状況が破損
async function installQueues(): Promise<void> {
	for (const binding of BINDINGS) {
		await runInDurableObject(shard(binding), (instance) => {
			(instance as any).env.TSUMUGI_QUEUE = queue;
		});
	}
}

async function settle(runId: string, source: Record<string, any> = performers, rounds = 14): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		await installQueues();
		for (const binding of BINDINGS) {
			await runDurableObjectAlarm(shard(binding));
		}
		if (sent.length > 0) {
			const batch = makeBatch([...sent]);
			sent.length = 0;
			await handleBatch(batch, consumerEnv, source);
		}
		await runDurableObjectAlarm(runStub(runId));
	}
}

const jobIdOf = (runId: string, nodeId: string) =>
	runInDurableObject(runStub(runId), (instance) => (instance as any).repo.findNode(nodeId)?.job_id as string | null);

const nodesOf = (runId: string) =>
	runInDurableObject(runStub(runId), (instance) =>
		((instance as any).repo.views() as { id: string; state: string }[]).map((node) => [node.id, node.state] as const),
	);

// 削除alarmは終端後も設定継続、alarm枯渇では収束判定不可
// 収束後の読み取りで自然発火tickとの重複による値のずれを防止
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

const stateOf = (runId: string) =>
	runInDurableObject(runStub(runId), (instance) => (instance as any).repo.findRun()?.state as string | undefined);

const errorOf = (runId: string, nodeId: string) =>
	runInDurableObject(runStub(runId), (instance) => (instance as any).repo.findNode(nodeId)?.error as string | null);

describe('縦串: runの開始から完了まで', () => {
	it('fan-outを含むflowが最後まで進む', async () => {
		performed.length = 0;
		const runId = 'GREETINGS:slice1';
		const stub = runStub(runId);
		await installQueues();

		const started = await stub.start({ flow: 'GREETINGS', input: { prefix: 'hello' } });
		expect(started).toEqual({ id: runId, created: true });
		expect(await stub.start({ flow: 'GREETINGS', input: { prefix: 'hello' } })).toEqual({ id: runId, created: false });

		expect(Object.fromEntries(await nodesOf(runId))).toEqual({ list: 'PENDING', greet: 'PENDING', report: 'PENDING' });

		await settle(runId);

		expect(await stateOf(runId)).toBe('COMPLETED');
		const nodes = Object.fromEntries(await nodesOf(runId));
		expect(nodes).toMatchObject({
			list: 'COMPLETED',
			greet: 'COMPLETED',
			'greet:0': 'COMPLETED',
			'greet:1': 'COMPLETED',
			'greet:2': 'COMPLETED',
			report: 'COMPLETED',
		});

		// 子は並列実行で順不同
		const greeted = performed.filter((p) => p.binding === 'Greet').map((p) => (p.payload as { name: string }).name);
		expect([...greeted].sort()).toEqual(['hello-1', 'hello-2', 'hello-3']);
		expect(performed.find((p) => p.binding === 'Report')?.payload).toEqual({ total: 3, failed: 0 });
	});

	it('performの中で追加した子を親が待つ(ADR-0032)', async () => {
		performed.length = 0;
		const runId = 'GREETINGS:spawn1';
		await installQueues();
		await runStub(runId).start({ flow: 'GREETINGS', input: { prefix: 'sp' } });
		await settle(runId, spawningPerformers);

		const nodes = Object.fromEntries(await nodesOf(runId));
		expect(nodes['greet:0:child']).toBe('COMPLETED');
		expect(nodes['report']).toBe('COMPLETED');
		expect(await stateOf(runId)).toBe('COMPLETED');
		// 3件の展開それぞれが子を1つ持ち6回実行
		expect(performed.filter((p) => p.binding === 'Greet')).toHaveLength(6);
	});

	it('不正なspawnのIDはノードのFAILEDになりtickを止めない', async () => {
		// consumerで事前検証、対象は検証追加前に記録された通知のみ
		const runId = 'GREETINGS:spawnbad';
		const stub = runStub(runId);
		await installQueues();
		await stub.start({ flow: 'GREETINGS', input: { prefix: 'sb' } });

		await settleRun(runId);
		sent.length = 0;
		const jobId = await jobIdOf(runId, 'list');
		if (jobId === null) throw new Error('the first node has no job id');
		await stub.notify([
			{
				nodeId: 'list',
				jobId,
				state: 'COMPLETED',
				result: JSON.stringify({ names: ['a'] }),
				error: null,
				spawns: [{ id: 'bad id', binding: 'Greet', payload: {} }],
			},
		]);
		await settleRun(runId);

		const nodes = Object.fromEntries(await nodesOf(runId));
		expect(nodes['list']).toBe('FAILED');
		expect(await stateOf(runId)).toBe('FAILED');
	});

	it('写像関数の例外はノードのFAILEDになる', async () => {
		const runId = 'GREETINGS:mapfail';
		const stub = runStub(runId);
		await installQueues();
		// input nullで`list`のinputがTypeError
		await stub.start({ flow: 'GREETINGS', input: null });
		await settleRun(runId);

		expect(Object.fromEntries(await nodesOf(runId))).toEqual({ list: 'FAILED', greet: 'SKIPPED', report: 'SKIPPED' });
		expect(await errorOf(runId, 'list')).toMatch(/^input failed:/);
		expect(await stateOf(runId)).toBe('FAILED');
	});

	it('ノードの失敗で下流が中断されrunがFAILEDになる', async () => {
		const runId = 'GREETINGS:fail1';
		const stub = runStub(runId);
		await installQueues();
		await stub.start({ flow: 'GREETINGS', input: { prefix: 'ng' } });

		await settleRun(runId);
		// 投入メッセージは配送対象外, 実行時は完了報告あり
		sent.length = 0;
		const jobId = await jobIdOf(runId, 'list');
		// 通知はジョブIDで宛先照合、未確定では検査不成立
		if (jobId === null) throw new Error('the first node has no job id');
		await stub.notify([{ nodeId: 'list', jobId, state: 'FAILED', result: null, error: 'intentional failure' }]);
		await settleRun(runId);

		expect(Object.fromEntries(await nodesOf(runId))).toEqual({ list: 'FAILED', greet: 'SKIPPED', report: 'SKIPPED' });
		expect(await stateOf(runId)).toBe('FAILED');

		expect(await stub.retry()).toEqual({ ok: true });
		expect(await stateOf(runId)).toBe('RUNNING');
		await settle(runId);
		expect(await stateOf(runId)).toBe('COMPLETED');
	});

	it('再開はfan-outで許容済みの子の失敗を再実行しない(ADR-0034)', async () => {
		const runId = 'GREETINGS:fanretry';
		const stub = runStub(runId);
		await installQueues();
		await stub.start({ flow: 'GREETINGS', input: { prefix: 'fr' } });

		const finish = async (nodeId: string, state: 'COMPLETED' | 'FAILED', result: unknown = null, error = 'intentional failure') => {
			await settleRun(runId);
			sent.length = 0;
			const jobId = await jobIdOf(runId, nodeId);
			if (jobId === null) throw new Error(`${nodeId} has no job id`);
			await stub.notify([{ nodeId, jobId, state, result: JSON.stringify(result), error: state === 'FAILED' ? error : null }]);
		};
		await finish('list', 'COMPLETED', { names: ['a', 'b'] });
		// 期限超過と同じ理由でも期限なしrunでは許容済みの失敗
		await finish('greet:0', 'FAILED', null, 'run deadline exceeded: 10000ms');
		await finish('greet:1', 'COMPLETED');
		await finish('report', 'FAILED');
		await settleRun(runId);
		expect(await stateOf(runId)).toBe('FAILED');
		const tolerated = await jobIdOf(runId, 'greet:0');

		expect(await stub.retry()).toEqual({ ok: true });
		expect(Object.fromEntries(await nodesOf(runId))).toMatchObject({ greet: 'COMPLETED', 'greet:0': 'FAILED', report: 'PENDING' });

		await finish('report', 'COMPLETED');
		await settleRun(runId);
		expect(await stateOf(runId)).toBe('COMPLETED');
		expect(await jobIdOf(runId, 'greet:0')).toBe(tolerated);
	});

	it('取り消しは未起動を止めて終端を待つ', async () => {
		const runId = 'GREETINGS:cancel1';
		const stub = runStub(runId);
		await installQueues();
		await stub.start({ flow: 'GREETINGS', input: { prefix: 'ca' } });

		expect(await stub.cancel()).toEqual({ ok: true });
		await settleRun(runId);

		expect(Object.fromEntries(await nodesOf(runId))).toEqual({ list: 'CANCELLED', greet: 'CANCELLED', report: 'CANCELLED' });
		expect(await stateOf(runId)).toBe('CANCELLED');
		expect(await stub.cancel()).toEqual({ ok: false, reason: 'invalid-state' });
	});

	it('決定の無い完了通知でもrunの進捗がD1へ投影される(ADR-0008)', async () => {
		const runId = 'GREETINGS:progress1';
		await installQueues();
		await runStub(runId).start({ flow: 'GREETINGS', input: { prefix: 'pg' } });
		await settleRun(runId);
		sent.length = 0;

		const listJob = await jobIdOf(runId, 'list');
		await runStub(runId).notify([
			{ nodeId: 'list', jobId: listJob!, state: 'COMPLETED', result: JSON.stringify({ names: ['a', 'b', 'c'] }), error: null },
		]);
		await settleRun(runId);
		sent.length = 0;

		const childJob = await jobIdOf(runId, 'greet:0');
		await runStub(runId).notify([{ nodeId: 'greet:0', jobId: childJob!, state: 'COMPLETED', result: null, error: null }]);
		await settleRun(runId);

		const row = await env.TSUMUGI_DB.prepare('SELECT node_done FROM run WHERE id = ?').bind(runId).first<{ node_done: number }>();
		expect(row?.node_done).toBe(2);
	});

	it('runとノードがD1へ投影される(ADR-0008)', async () => {
		const runId = 'GREETINGS:slice2';
		await installQueues();
		await runStub(runId).start({ flow: 'GREETINGS', input: { prefix: 'proj' } });
		await settle(runId);

		const row = await env.TSUMUGI_DB.prepare('SELECT state, node_total, node_done FROM run WHERE id = ?')
			.bind(runId)
			.first<{ state: string; node_total: number; node_done: number }>();
		expect(row).toMatchObject({ state: 'COMPLETED', node_total: 6, node_done: 6 });

		const nodes = await env.TSUMUGI_DB.prepare('SELECT node_id, state, container FROM run_node WHERE run_id = ? ORDER BY position')
			.bind(runId)
			.all<{ node_id: string; state: string; container: number }>();
		expect(nodes.results.map((n) => n.node_id)).toEqual(['list', 'greet', 'report', 'greet:0', 'greet:1', 'greet:2']);
		expect(nodes.results.find((n) => n.node_id === 'greet')?.container).toBe(1);

		// ジョブ側にも宛先記録, 画面から相互参照可(ADR-0015)
		const job = await env.TSUMUGI_DB.prepare('SELECT run_id, node_id FROM job WHERE run_id = ? AND node_id = ?')
			.bind(runId, 'list')
			.first<{ run_id: string; node_id: string }>();
		expect(job).toEqual({ run_id: runId, node_id: 'list' });
	});
});
