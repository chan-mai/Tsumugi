import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { DispatchMessage } from '../../src/do/job-shard.js';
import type { NodeEvent } from '../../src/core/run.js';
import { handleBatch, type ConsumerEnv } from '../../src/queue/consumer.js';

/**
 * 条件分岐と失敗時の継続(ADR-0041)
 *
 * flowの定義はexamples/basicが持つ(BRANCHED), Run DOはそこから引く(ADR-0030)
 * cleanupはtrigger=failure, auditはtrigger=always, detailはwhenで経路を選ぶ
 */

/** 面をそのまま使うと型の展開が深くなりTS2589に抵触, 使う分だけを宣言 */
interface RunFace extends Rpc.DurableObjectBranded {
	start(input: { flow: string; input: unknown }): Promise<{ id: string; created: boolean }>;
	notify(events: readonly NodeEvent[]): Promise<void>;
}

const namespace = env.RUN as unknown as DurableObjectNamespace<RunFace>;
const runStub = (runId: string) => namespace.get(namespace.idFromName(runId));
const shard = (binding: string) => env.JOB_SHARD.get(env.JOB_SHARD.idFromName(`${binding}#0`));

const consumerEnv: ConsumerEnv = env;
const BINDINGS = ['ListNames', 'Report'] as const;

const performers = {
	ListNames: { perform: async (payload: { prefix: string }) => ({ names: [`${payload.prefix}-1`] }) },
	Report: { perform: async (_payload: { total: number; failed: number }): Promise<void> => {} },
};

/** DOが送ったメッセージを保持してconsumerへ手で渡す */
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
		await runInDurableObject(shard(binding), (instance) => {
			(instance as any).env.TSUMUGI_QUEUE = queue;
		});
	}
}

/** Job DOとRun DOのalarmを交互に発火させ, 進みが止まるまで回す */
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
	runInDurableObject(runStub(runId), (instance) =>
		Object.fromEntries(((instance as any).repo.views() as { id: string; state: string }[]).map((node) => [node.id, node.state])),
	);

const errorOf = (runId: string, nodeId: string) =>
	runInDurableObject(runStub(runId), (instance) => (instance as any).repo.findNode(nodeId)?.error as string | null);

const stateOf = (runId: string) =>
	runInDurableObject(runStub(runId), (instance) => (instance as any).repo.findRun()?.state as string | undefined);

const jobIdOf = (runId: string, nodeId: string) =>
	runInDurableObject(runStub(runId), (instance) => (instance as any).repo.findNode(nodeId)?.job_id as string | null);

/** 進みが止まるまでRun DOのtickだけを回す */
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
		// 省略の理由が残る, 状態だけでは判別不能
		expect(await errorOf(runId, 'cleanup')).toBe('no dependency failed');
		// 分岐で選択されなかっただけでrunは成功
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

	it('上流が失敗すると後始末が通りrunはFAILEDのまま', async () => {
		const runId = 'BRANCHED:ng';
		const stub = runStub(runId);
		await installQueues();
		await stub.start({ flow: 'BRANCHED', input: { prefix: 'ng', verbose: true } });

		// 先頭ノードを投入まで進めてから, 失敗の通知だけを手で届ける
		await settleRun(runId);
		sent.length = 0;
		const jobId = await jobIdOf(runId, 'list');
		if (jobId === null) throw new Error('the first node has no job id');
		await stub.notify([{ nodeId: 'list', jobId, state: 'FAILED', result: null, error: 'intentional failure' }]);
		await settle(runId);

		expect(await nodesOf(runId)).toEqual({
			list: 'FAILED',
			// 失敗時だけ実行される後処理と、成否を問わない監査は実行
			cleanup: 'COMPLETED',
			audit: 'COMPLETED',
			// 成功を待つノードは省略
			detail: 'SKIPPED',
		});
		expect(await errorOf(runId, 'detail')).toBe('a dependency did not succeed');
		// 後始末が成功しても失敗した事実は消えない
		expect(await stateOf(runId)).toBe('FAILED');
	});
});
