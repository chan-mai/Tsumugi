import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { DispatchMessage } from '../../src/do/job-shard.js';
import type { TsumugiRunInstance } from '../../src/do/run.js';

// alarmはハンドラ開始時に消去、tick中のalarmは割り込み処理の要求
// setAlarm上書きで割り込み報告の投影が保持期間経過まで遅延
// 完了済みジョブが数分間QUEUED表示された不具合の回帰テスト

const T0 = 2_500_000_000_000;

// `runInDurableObject`のインスタンスは型情報なし、使用分のみ宣言
type Internals = {
	ctx: DurableObjectState;
	clock: { now(): number };
	alarm(): Promise<void>;
	repo: { find(id: string): { state: string } | undefined };
};

const internals = (instance: unknown) => instance as Internals;

function captureQueue() {
	const sent: DispatchMessage[] = [];
	return {
		sent,
		queue: {
			send: async (body: DispatchMessage) => void sent.push(body),
			sendBatch: async (batch: Iterable<{ body: DispatchMessage }>) => {
				for (const m of batch) sent.push(m.body);
			},
		},
	};
}

const shard = (name: string) => env.JOB_SHARD.get(env.JOB_SHARD.idFromName(name));
const runNamespace = env.RUN as unknown as DurableObjectNamespace<TsumugiRunInstance>;
const runStub = (runId: string) => runNamespace.get(runNamespace.idFromName(runId));

describe('tick中に設定されたalarm', () => {
	it('Job DOは削除の予定で上書きしない', async () => {
		const { sent, queue } = captureQueue();
		await runInDurableObject(shard('CLOBBER#0'), (instance) => {
			internals(instance).clock = { now: () => T0 };
			(internals(instance) as unknown as { env: { TSUMUGI_QUEUE: unknown } }).env.TSUMUGI_QUEUE = queue;
		});

		const jobId = await shard('CLOBBER#0').enqueue({ binding: 'CLOBBER', payload: {} });
		await runDurableObjectAlarm(shard('CLOBBER#0'));
		await shard('CLOBBER#0').report(sent[0]!.jobId, { ok: true });

		await runInDurableObject(shard('CLOBBER#0'), async (instance) => {
			const inner = internals(instance);
			// 割り込み報告のalarm設定を再現, ハンドラ直接呼び出しでは消去なし
			await inner.ctx.storage.setAlarm(T0 + 1_000);
			await inner.alarm();
			expect(await inner.ctx.storage.getAlarm()).toBe(T0 + 1_000);
			expect(inner.repo.find(jobId)?.state).toBe('COMPLETED');
		});
	});

	it('Run DOは削除の予定で上書きしない', async () => {
		const { queue } = captureQueue();
		// 実キューではconsumer実行、完了通知のalarm設定で検査が不安定化
		await runInDurableObject(shard('LIST#0'), (instance) => {
			(internals(instance) as unknown as { env: { TSUMUGI_QUEUE: unknown } }).env.TSUMUGI_QUEUE = queue;
		});

		const stub = runStub('GREETINGS:clobber1');
		await stub.start({ flow: 'GREETINGS', input: { prefix: 'cl' } });
		await stub.cancel();
		await runDurableObjectAlarm(stub);

		await runInDurableObject(stub, async (instance) => {
			const inner = internals(instance);
			const now = inner.clock.now();
			await inner.ctx.storage.setAlarm(now + 1_000);
			await inner.alarm();
			expect(await inner.ctx.storage.getAlarm()).toBe(now + 1_000);
		});
	});
});

describe('tickが失敗した場合の再設定', () => {
	// 再試行予定による割り込み要求の早い予定の上書き防止
	it('Job DOは早い予定を残す', async () => {
		await runInDurableObject(shard('CLOBBERFAIL#0'), async (instance) => {
			const inner = internals(instance) as Internals & { repo: { scheduleWindow(): never } };
			inner.clock = { now: () => T0 };
			inner.repo.scheduleWindow = () => {
				throw new Error('intentional failure');
			};
			await inner.ctx.storage.setAlarm(T0 + 1_000);
			await inner.alarm();
			expect(await inner.ctx.storage.getAlarm()).toBe(T0 + 1_000);
		});
	});

	it('Run DOは早い予定を残す', async () => {
		const stub = runStub('GREETINGS:clobberfail1');
		await stub.start({ flow: 'GREETINGS', input: { prefix: 'cf' } });
		await runInDurableObject(stub, async (instance) => {
			const inner = internals(instance) as Internals & { repo: { findRun(): never } };
			inner.clock = { now: () => T0 };
			inner.repo.findRun = () => {
				throw new Error('intentional failure');
			};
			await inner.ctx.storage.setAlarm(T0 + 1_000);
			await inner.alarm();
			expect(await inner.ctx.storage.getAlarm()).toBe(T0 + 1_000);
		});
	});

	it('Scheduler DOは早い予定を残す', async () => {
		const namespace = env.SCHEDULER as unknown as DurableObjectNamespace;
		const stub = namespace.get(namespace.idFromName('scheduler-clobberfail'));
		await runInDurableObject(stub, async (instance) => {
			const inner = internals(instance) as Internals & { repo: { rows(): never } };
			inner.clock = { now: () => T0 };
			inner.repo.rows = () => {
				throw new Error('intentional failure');
			};
			await inner.ctx.storage.setAlarm(T0 + 1_000);
			await inner.alarm();
			expect(await inner.ctx.storage.getAlarm()).toBe(T0 + 1_000);
		});
	});
});
