import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createClient } from '../../src/client/enqueue.js';
import { formatJobId } from '../../src/core/ids.js';

import type { Clock } from '../../src/do/clock.js';
import type { JobRepo } from '../../src/do/repo.js';
import type { RunRepo } from '../../src/do/run-repo.js';
import type { SchedulerRepo } from '../../src/do/scheduler-repo.js';

// Run DO / Scheduler DOの経路はexamples/basicのonEnqueue(ListNamesへtimeoutMs 45_000)で確認

type ShardInternals = {
	env: { TSUMUGI_QUEUE: unknown };
	repo: JobRepo;
};

const internals = (instance: unknown) => instance as ShardInternals;

const shard = (name: string) => env.JOB_SHARD.get(env.JOB_SHARD.idFromName(name));

// 実キューはconsumer実行で状態変化
const install = (name: string) =>
	runInDurableObject(shard(name), instance => {
		internals(instance).env.TSUMUGI_QUEUE = {
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
		const client = createClient({}, {}, { onEnqueue: input => (input.binding === 'HOOK1' ? { timeoutMs: 45_000 } : undefined) });

		const id = await client.enqueue(env as never, { binding: 'HOOK1', payload: {} });

		const row = await runInDurableObject(shard('HOOK1#0'), instance => internals(instance).repo.find(id));
		expect(row?.timeout_ms).toBe(45_000);
	});

	it('Run DOが投入するノードにも適用される', async () => {
		await install('ListNames#0');
		const runNamespace = env.RUN as unknown as DurableObjectNamespace<RunFace>;
		const stub = runNamespace.get(runNamespace.idFromName('GREETINGS:enqueue-hook'));
		await stub.start({ flow: 'GREETINGS', input: { prefix: 'enqhook' } });

		// ノード投入はRun DOのtickで実施, 確定までalarm反復
		let jobId: string | null = null;
		for (let i = 0; i < 10 && jobId === null; i++) {
			await runDurableObjectAlarm(stub as never);
			jobId = await runInDurableObject(
				stub as never,
				instance => (instance as unknown as { repo: RunRepo }).repo.findNode('list')?.job_id ?? null,
			);
		}
		if (jobId === null) throw new Error('node job id is missing');

		const row = await runInDurableObject(shard('ListNames#0'), instance => internals(instance).repo.find(jobId));
		expect(row?.timeout_ms).toBe(45_000);
	});

	it('Scheduler DOが投入するジョブにも適用される', async () => {
		await install('ListNames#0');
		await install('Hello#0');
		const schedulerNamespace = env.SCHEDULER as unknown as DurableObjectNamespace<SchedulerFace>;
		const scheduler = schedulerNamespace.get(schedulerNamespace.idFromName('scheduler'));
		await scheduler.sync();
		const nextOccurrenceAt = await runInDurableObject(scheduler, instance => {
			const schedule = (instance as unknown as { repo: SchedulerRepo }).repo.find('poll-names');
			if (schedule === undefined) throw new Error('schedule is missing: poll-names');
			return schedule.next_occurrence_at;
		});
		// poll-names間隔5分, 初回時刻超過まで時計を前進
		const ahead = Temporal.Now.instant().epochMilliseconds + 6 * 60_000;
		await runInDurableObject(scheduler, instance => void ((instance as unknown as { clock: Clock }).clock = { now: () => ahead }));
		await runDurableObjectAlarm(scheduler);

		const jobId = formatJobId({ binding: 'ListNames', shard: 0, localId: `poll-names-${nextOccurrenceAt}` });
		const row = await runInDurableObject(shard('ListNames#0'), instance => internals(instance).repo.find(jobId));
		expect(row?.timeout_ms).toBe(45_000);
	});
});
