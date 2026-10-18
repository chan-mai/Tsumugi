import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createClient } from '../../src/client/enqueue.js';
import { formatJobId } from '../../src/core/ids.js';

/**
 * 投入時の既定値フック(#96)
 *
 * worker clientの適用はここでDOの行まで確認
 * Run DO / Scheduler DOの経路はexamples/basicのonEnqueue(ListNamesへtimeoutMs 45_000)で確認
 */

const shard = (name: string) => env.JOB_SHARD.get(env.JOB_SHARD.idFromName(name));

/** 投入先を差し替える, 実キューへ出すとconsumerが走って状態が変わる */
const install = (name: string) =>
	runInDurableObject(shard(name), (instance) => {
		(instance as any).env.TSUMUGI_QUEUE = {
			send: async () => {},
			sendBatch: async () => {},
		};
	});

interface RunFace extends Rpc.DurableObjectBranded {
	start(input: { flow: string; input: unknown }): Promise<{ id: string }>;
}
interface SchedulerFace extends Rpc.DurableObjectBranded {
	sync(): Promise<void>;
}

describe('投入時の既定値フック(#96)', () => {
	it('clientのフックがDOの行まで反映される', async () => {
		await install('HOOK1#0');
		const client = createClient({}, {}, { onEnqueue: (input) => (input.binding === 'HOOK1' ? { timeoutMs: 45_000 } : undefined) });

		const id = await client.enqueue(env as never, { binding: 'HOOK1', payload: {} });

		const row = await runInDurableObject(shard('HOOK1#0'), (instance) => (instance as any).repo.find(id) as { timeout_ms: number });
		expect(row.timeout_ms).toBe(45_000);
	});

	it('Run DOが投入するノードにも適用される', async () => {
		await install('ListNames#0');
		const runNamespace = env.RUN as unknown as DurableObjectNamespace<RunFace>;
		const stub = runNamespace.get(runNamespace.idFromName('GREETINGS:enqueue-hook'));
		await stub.start({ flow: 'GREETINGS', input: { prefix: 'enqhook' } });

		// ノードの投入はRun DOのtickが行う, 確定するまでalarmを回す
		let jobId: string | null = null;
		for (let i = 0; i < 10 && jobId === null; i++) {
			await runDurableObjectAlarm(stub as never);
			jobId = await runInDurableObject(
				stub as never,
				(instance) => ((instance as any).repo.findNode('list')?.job_id ?? null) as string | null,
			);
		}

		// examples/basicのonEnqueueはListNamesへtimeoutMs 45_000を付与
		const row = await runInDurableObject(shard('ListNames#0'), (instance) => (instance as any).repo.find(jobId) as { timeout_ms: number });
		expect(row.timeout_ms).toBe(45_000);
	});

	it('Scheduler DOが投入するジョブにも適用される', async () => {
		await install('ListNames#0');
		await install('Hello#0');
		const schedulerNamespace = env.SCHEDULER as unknown as DurableObjectNamespace<SchedulerFace>;
		const scheduler = schedulerNamespace.get(schedulerNamespace.idFromName('scheduler'));
		await scheduler.sync();
		const nextRunAt = await runInDurableObject(
			scheduler,
			(instance) => ((instance as any).repo.find('poll-names') as { next_run_at: number }).next_run_at,
		);
		// poll-namesの間隔が5分, 初回時刻を超えるため時計を前進
		const ahead = Date.now() + 6 * 60_000;
		await runInDurableObject(scheduler, (instance) => void ((instance as any).clock = { now: () => ahead }));
		await runDurableObjectAlarm(scheduler);

		// poll-namesがListNamesへ投入, 定期実行の経路にも既定値が届く
		const jobId = formatJobId({ binding: 'ListNames', shard: 0, localId: `poll-names-${nextRunAt}` });
		const row = await runInDurableObject(shard('ListNames#0'), (instance) => (instance as any).repo.find(jobId) as { timeout_ms: number });
		expect(row.timeout_ms).toBe(45_000);
	});
});
