import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { EnqueueInput } from '../../src/do/job-shard.js';
import type { NodeEvent } from '../../src/core/run.js';

// ジョブ投入はRPC、await中にJob DOの完了通知が割り込み(#33)
// 投入後の更新で終端ノードを起動中へ戻すと通知が再送されずrunがRUNNINGのまま

// DO型直接参照でTS2589発生, 使用メソッドのみ宣言
interface RunFace extends Rpc.DurableObjectBranded {
	start(input: { flow: string; input: unknown }): Promise<{ id: string; created: boolean }>;
}

const namespace = env.RUN as unknown as DurableObjectNamespace<RunFace>;
const runStub = (runId: string) => namespace.get(namespace.idFromName(runId));

const nodesOf = (runId: string) =>
	runInDurableObject(runStub(runId), (instance) =>
		Object.fromEntries(((instance as any).repo.views() as { id: string; state: string }[]).map((n) => [n.id, n.state])),
	);

const stateOf = (runId: string) =>
	runInDurableObject(runStub(runId), (instance) => (instance as any).repo.findRun()?.state as string | undefined);

// 実Job DOでも投入ジョブ即完了時は同じ順序
// DOストレージはテスト間で残存、前回の行も削除して開始
async function installEagerShard(runId: string): Promise<void> {
	await runInDurableObject(runStub(runId), (instance) => {
		const self = instance as any;
		for (const table of ['run', 'node', 'run_outbox']) self.repo.sql.exec(`DELETE FROM ${table}`);

		const original = self.env.JOB_SHARD;
		self.env.JOB_SHARD = {
			idFromName: (name: string) => original.idFromName(name),
			get: (id: DurableObjectId) => ({
				id,
				enqueueMany: async (inputs: readonly EnqueueInput[]) => {
					// 投入応答前に完了通知, Run DOのノードは起動中へ未遷移
					const events: NodeEvent[] = inputs.map((input) => ({
						nodeId: input.nodeId as string,
						jobId: input.id as string,
						state: 'COMPLETED',
						result: JSON.stringify({ names: [] }),
						error: null,
					}));
					await self.notify(events);
					return inputs.map((input) => input.id);
				},
			}),
		};
	});
}

describe('投入と完了通知の競合(#33)', () => {
	it('投入を待つ間に完了したノードを起動中へ戻さない', async () => {
		const runId = 'GREETINGS:race1';
		const stub = runStub(runId);
		// リセットによる開始済み行の削除防止、開始前に設定
		await installEagerShard(runId);
		await stub.start({ flow: 'GREETINGS', input: { prefix: 'race' } });

		await runDurableObjectAlarm(stub);

		expect((await nodesOf(runId))['list']).toBe('COMPLETED');
	});

	it('通知を追い越さずにrunが決着する', async () => {
		const runId = 'GREETINGS:race2';
		const stub = runStub(runId);
		// リセットによる開始済み行の削除防止、開始前に設定
		await installEagerShard(runId);
		await stub.start({ flow: 'GREETINGS', input: { prefix: 'race' } });

		// 進行停止まで反復, 各tickの投入は即完了
		for (let i = 0; i < 8; i++) await runDurableObjectAlarm(stub);

		expect(await stateOf(runId)).toBe('COMPLETED');
		const nodes = await nodesOf(runId);
		expect(nodes['list']).toBe('COMPLETED');
		expect(nodes['report']).toBe('COMPLETED');
	});
});
