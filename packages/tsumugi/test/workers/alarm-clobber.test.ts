import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { DispatchMessage } from '../../src/do/job-shard.js';
import type { TsumugiRunInstance } from '../../src/do/run.js';

/**
 * tickの実行中に設定されたalarmを後ろへずらさないこと
 *
 * alarmはハンドラの開始時に消え、tick中に在るalarmは割り込んだ処理が要求した予定
 * setAlarmで上書きすると、割り込んだ報告の投影が保持期間の経過まで遅延
 * 実環境で完了済みのジョブが数分間QUEUEDのまま見えた不具合の回帰テスト
 */

const T0 = 2_500_000_000_000;

/** DOの内側, `runInDurableObject`が渡すインスタンスの型は実装を持たず限定して宣言 */
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

		// 終端ジョブを作る, これで削除の予定が保持期間の後ろに入る
		const jobId = await shard('CLOBBER#0').enqueue({ binding: 'CLOBBER', payload: {} });
		await runDurableObjectAlarm(shard('CLOBBER#0'));
		await shard('CLOBBER#0').report(sent[0]!.jobId, { ok: true });

		await runInDurableObject(shard('CLOBBER#0'), async (instance) => {
			const inner = internals(instance);
			// 割り込んだ報告がalarmを設定した状態を作る, ハンドラの直接呼び出しでは消えない
			await inner.ctx.storage.setAlarm(T0 + 1_000);
			await inner.alarm();
			expect(await inner.ctx.storage.getAlarm()).toBe(T0 + 1_000);
			expect(inner.repo.find(jobId)?.state).toBe('COMPLETED');
		});
	});

	it('Run DOは削除の予定で上書きしない', async () => {
		const { queue } = captureQueue();
		// 実キューへ送るとconsumerが実行され、完了通知によるalarm設定で検査が不安定化
		await runInDurableObject(shard('LIST#0'), (instance) => {
			(internals(instance) as unknown as { env: { TSUMUGI_QUEUE: unknown } }).env.TSUMUGI_QUEUE = queue;
		});

		const stub = runStub('GREETINGS:clobber1');
		await stub.start({ flow: 'GREETINGS', input: { prefix: 'cl' } });
		// 取り消して終端へ進める, 削除の予定が保持期間の後ろに入る
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
