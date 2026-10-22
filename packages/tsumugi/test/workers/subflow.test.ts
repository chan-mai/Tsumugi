import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { DispatchMessage } from '../../src/do/job-shard.js';
import type { TsumugiRunInstance } from '../../src/do/run.js';
import { handleBatch, type ConsumerEnv } from '../../src/queue/consumer.js';

// flow定義はexamples/basic(PIPELINEがGREETINGSを起動)

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

// performer未実行で投入まで, 固定ラウンド数では進行過多の場合あり
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
		expect((await nodeOf(parent, 'summary'))?.state).toBe('COMPLETED');
		expect(await stateOf(parent)).toBe('COMPLETED');
	});

	it('子のrunIdが親のrunIdとノードIDから決まる', async () => {
		const parent = 'PIPELINE:sub-id';
		await runStub(parent).start({ flow: 'PIPELINE', input: { prefix: 'x' } });
		await settle([parent, 'GREETINGS:sub-id-greetings'], registry, 2);

		expect((await nodeOf(parent, 'greetings'))?.child_run_id).toBe('GREETINGS:sub-id-greetings');
	});

	it('子が失敗すると親のノードも失敗し下流を中断する', async () => {
		const parent = 'PIPELINE:sub-fail';
		const child = 'GREETINGS:sub-fail-greetings';
		await runStub(parent).start({ flow: 'PIPELINE', input: { prefix: 'x' } });
		await settleRuns([parent, child]);
		// 投入メッセージは配送対象外, 実行時は完了報告あり
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

	it('親の再開で失敗した子も失敗したノードから再開する(ADR-0034)', async () => {
		const parent = 'PIPELINE:sub-retry';
		const child = 'GREETINGS:sub-retry-greetings';
		await runStub(parent).start({ flow: 'PIPELINE', input: { prefix: 'x' } });
		await settleRuns([parent, child]);
		sent.length = 0;
		const jobId = (await nodeOf(child, 'list'))?.job_id;
		if (!jobId) throw new Error('the first node of the child run has no job id');
		await runStub(child).notify([{ nodeId: 'list', jobId, state: 'FAILED', result: null, error: 'intentional failure' }]);
		await settleRuns([parent, child]);
		expect(await stateOf(parent)).toBe('FAILED');

		// 子は保持期間内で残存, 同じ子runIdの起動で既存を返却
		await runStub(parent).retry();
		await settle([parent, child], registry);

		expect(await stateOf(child)).toBe('COMPLETED');
		expect((await nodeOf(parent, 'greetings'))?.state).toBe('COMPLETED');
		expect(await stateOf(parent)).toBe('COMPLETED');
	});

	it('子のflow定義が消えた場合も親へ失敗を通知し削除を予約する(ADR-0030)', async () => {
		const parent = 'PIPELINE:sub-gone';
		const child = 'GREETINGS:sub-gone-greetings';
		await runStub(parent).start({ flow: 'PIPELINE', input: { prefix: 'x' } });
		await settleRuns([parent, child]);
		sent.length = 0;

		// デプロイで子flowが定義から削除, ジョブ完了待ちでalarmなく直接起動
		await runInDurableObject(runStub(child), async (instance) => {
			(instance as any).repo.sql.exec(`UPDATE run SET flow = 'REMOVED'`);
			await (instance as any).alarm();
		});
		await settleRuns([parent]);

		expect(await stateOf(child)).toBe('FAILED');
		expect((await nodeOf(parent, 'greetings'))?.state).toBe('FAILED');
		expect(await stateOf(parent)).toBe('FAILED');
		// 保持期間経過後の削除予定, 未設定時はDO残存
		const alarm = await runInDurableObject(
			runStub(child),
			(instance) => (instance as any).ctx.storage.getAlarm() as Promise<number | null>,
		);
		expect(alarm).not.toBeNull();
	});

	it('起動失敗と判定済みのノードへ子の完了を適用しない', async () => {
		const parent = 'PIPELINE:sub-lost';
		const child = 'GREETINGS:sub-lost-greetings';
		await runStub(parent).start({ flow: 'PIPELINE', input: { prefix: 'x' } });
		await settleRuns([parent, child]);
		sent.length = 0;

		// 子の起動RPCが無応答、親のみ失敗と判定
		await runInDurableObject(runStub(parent), (instance) => {
			(instance as any).repo.sql.exec(`UPDATE node SET state = 'FAILED' WHERE id = 'greetings'`);
		});
		await runStub(parent).notifyChild('greetings', child, 'COMPLETED');

		expect((await nodeOf(parent, 'greetings'))?.state).toBe('FAILED');
	});

	it('親への通知に失敗したら間隔を空けて再送する', async () => {
		const child = 'GREETINGS:notify-retry';
		const T = 2_600_000_000_000;
		await runStub(child).start({
			flow: 'GREETINGS',
			input: { prefix: 'x' },
			parent: { runId: 'PIPELINE:notify-retry', nodeId: 'greetings' },
			depth: 1,
		});
		await settleRuns([child]);
		sent.length = 0;
		const jobId = (await nodeOf(child, 'list'))?.job_id;
		if (!jobId) throw new Error('the first node of the child run has no job id');

		const alarm = await runInDurableObject(runStub(child), async (instance) => {
			(instance as any).clock = { now: () => T };
			// 親Run DOへ通知不達, envは他テストと共有で終了時に復元
			const original = (instance as any).env.RUN;
			(instance as any).env.RUN = {
				idFromName: (name: string) => ({ name }),
				get: () => ({
					notifyChild: async () => {
						throw new Error('unreachable');
					},
				}),
			};
			try {
				await (instance as any).notify([{ nodeId: 'list', jobId, state: 'FAILED', result: null, error: 'boom' }]);
				await (instance as any).ctx.storage.deleteAlarm();
				await (instance as any).alarm();
				return (await (instance as any).ctx.storage.getAlarm()) as number | null;
			} finally {
				(instance as any).env.RUN = original;
			}
		});

		// 即時再起動では失敗中にtick反復
		expect(alarm).toBeGreaterThan(T);
	});

	it('親を取り消すと子も取り消される', async () => {
		const parent = 'PIPELINE:sub-cancel';
		const child = 'GREETINGS:sub-cancel-greetings';
		await runStub(parent).start({ flow: 'PIPELINE', input: { prefix: 'x' } });
		await settle([parent, child], registry, 2);
		expect(await stateOf(child)).toBe('RUNNING');

		await runStub(parent).cancel();
		await settle([parent, child], registry);

		expect(await stateOf(child)).toBe('CANCELLED');
		expect(await stateOf(parent)).toBe('CANCELLED');
	});

	it('入れ子の上限を超える起動を拒否する', async () => {
		// 既定上限3, 深さ判定は起動先で実施
		// RPC越し例外はvitest-pool-workersで未処理rejection扱い、DO内で実行
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
