import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { EnqueueInput } from '../../src/do/job-shard.js';
import type { NodeEvent } from '../../src/core/run.js';

/**
 * 投入と完了通知の競合(#33)
 *
 * ジョブの投入はRPCで、awaitの間にJob DOからの完了通知が割り込む
 * 投入後の状態更新が終端のノードを起動中へ戻すと、通知は二度と届かずrunが永久にRUNNINGのまま
 */

/** 面をそのまま使うと型の展開が深くなりTS2589に抵触, 使う分だけを宣言 */
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

/**
 * 投入の最中に完了通知を届けるJob DOの替え玉を仕込む
 * 実際のJob DOでも、投入したジョブが即座に完了すれば同じ順序
 * DOのストレージはテストを跨いで残り、前回の行も削除してから開始
 */
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
					// 投入の応答を返す前に完了を伝える, Run DOはまだノードを起動中にしていない
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
		// 開始より先に設定, リセットによる開始済みの行の削除を防止
		await installEagerShard(runId);
		await stub.start({ flow: 'GREETINGS', input: { prefix: 'race' } });

		await runDurableObjectAlarm(stub);

		// 起動前へ戻すとJob DO側は終端のため通知が二度と届かず, ノードがSCHEDULEDのまま残る
		expect((await nodesOf(runId))['list']).toBe('COMPLETED');
	});

	it('通知を追い越さずにrunが決着する', async () => {
		const runId = 'GREETINGS:race2';
		const stub = runStub(runId);
		// 開始より先に設定, リセットによる開始済みの行の削除を防止
		await installEagerShard(runId);
		await stub.start({ flow: 'GREETINGS', input: { prefix: 'race' } });

		// 進みが止まるまで回す, 各tickの投入がその場で完了に変わる
		for (let i = 0; i < 8; i++) await runDurableObjectAlarm(stub);

		expect(await stateOf(runId)).toBe('COMPLETED');
		const nodes = await nodesOf(runId);
		expect(nodes['list']).toBe('COMPLETED');
		expect(nodes['report']).toBe('COMPLETED');
	});
});
