import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { DispatchMessage } from '../../src/do/job-shard.js';

/**
 * tickの実行中に張られたalarmを後ろへずらさないこと
 *
 * alarmはハンドラの開始時に消えるので, tick中に在るalarmは割り込んだ処理が要求した予定
 * setAlarmで上書きすると, 割り込んだ報告の投影が保持期間の経過まで待たされる
 * 実環境で完了済みのジョブが数分間QUEUEDのまま見えた不具合の回帰テスト
 */

const T0 = 2_500_000_000_000;

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
const runStub = (runId: string) => (env as unknown as { RUN: DurableObjectNamespace<any> }).RUN.get((env as any).RUN.idFromName(runId));

describe('tick中に張られたalarm', () => {
	it('Job DOは掃除の予定で上書きしない', async () => {
		const { sent, queue } = captureQueue();
		await runInDurableObject(shard('CLOBBER#0'), (instance) => {
			(instance as any).clock = { now: () => T0 };
			(instance as any).env.TSUMUGI_QUEUE = queue;
		});

		// 終端ジョブを作る, これで掃除の予定が保持期間の後ろに立つ
		const jobId = await shard('CLOBBER#0').enqueue({ binding: 'CLOBBER', payload: {} });
		await runDurableObjectAlarm(shard('CLOBBER#0'));
		await shard('CLOBBER#0').report(sent[0]!.jobId, { ok: true });

		await runInDurableObject(shard('CLOBBER#0'), async (instance) => {
			// 割り込んだ報告がalarmを張った状態を作る, ハンドラを直接呼ぶので消えない
			await instance.ctx.storage.setAlarm(T0 + 1_000);
			await (instance as any).alarm();
			expect(await instance.ctx.storage.getAlarm()).toBe(T0 + 1_000);
		});

		expect(await runInDurableObject(shard('CLOBBER#0'), (instance) => (instance as any).repo.find(jobId)?.state)).toBe('COMPLETED');
	});

	it('Run DOは掃除の予定で上書きしない', async () => {
		const runId = 'GREETINGS:clobber1';
		const stub = runStub(runId);
		await stub.start({ flow: 'GREETINGS', input: { prefix: 'cl' } });
		// 取り消して終端へ運ぶ, 掃除の予定が保持期間の後ろに立つ
		await stub.cancel();
		await runDurableObjectAlarm(stub);

		await runInDurableObject(stub, async (instance) => {
			const now = (instance as any).clock.now() as number;
			await instance.ctx.storage.setAlarm(now + 1_000);
			await (instance as any).alarm();
			expect(await instance.ctx.storage.getAlarm()).toBe(now + 1_000);
		});
	});
});
