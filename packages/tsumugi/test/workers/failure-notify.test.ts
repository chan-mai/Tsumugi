import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { DispatchMessage } from '../../src/do/job-shard.js';
import type { FailureNotice } from '../../src/core/types.js';
import { failureNotify } from '../../src/do/tables.js';
import { parseJobId } from '../../src/core/ids.js';

/**
 * 失敗したジョブの通知(#30)
 *
 * 終端の失敗だけを通知先のbindingへジョブとして投入する
 * 通知そのものの失敗は投入しない, 自分を呼び続ける循環になる
 */

const T0 = 2_500_000_000_000;
const NOTIFY = 'NotifyFailure';

const shard = (name: string) => env.JOB_SHARD.get(env.JOB_SHARD.idFromName(name));

/** 投入先を差し替える, 実キューへ出すとconsumerが走って状態が変わる */
async function install(name: string, sent: DispatchMessage[] = []): Promise<void> {
	await runInDurableObject(shard(name), (instance) => {
		(instance as any).clock = { now: () => T0 };
		(instance as any).env.TSUMUGI_QUEUE = {
			send: async (body: DispatchMessage) => void sent.push(body),
			sendBatch: async (batch: Iterable<{ body: DispatchMessage }>) => {
				for (const m of batch) sent.push(m.body);
			},
		};
	});
}

/** 通知先へ届いたジョブのpayload, 宛先はshard 0に固定される */
const payloadOf = (jobId: string) =>
	runInDurableObject(shard(`${NOTIFY}#0`), (instance) => {
		const row = (instance as any).repo.find(jobId) as { payload: string } | undefined;
		return row ? (JSON.parse(row.payload) as FailureNotice) : undefined;
	});

/** 通知として投入されるジョブのID, 元のIDのローカル部から決まる */
const noticeIdOf = (jobId: string, attempts: number) => `${NOTIFY}#0:failure-${parseJobId(jobId).localId}-${attempts}`;

/** flowと定期実行の起動口, RPCの型はブランドを継承する必要がある */
interface RunFace extends Rpc.DurableObjectBranded {
	start(input: { flow: string; input: unknown }): Promise<unknown>;
}
interface SchedulerFace extends Rpc.DurableObjectBranded {
	sync(): Promise<void>;
}

/** DOに保存された設定, 投入の経路ごとに宛先が届いているかを見る */
const settingsOf = (name: string) =>
	runInDurableObject(shard(name), (instance) => {
		const raw = (instance as any).repo.readSetting('settings') as string | undefined;
		return raw ? (JSON.parse(raw) as { failureBinding?: string }) : undefined;
	});

const countOf = (name: string) => runInDurableObject(shard(name), (instance) => (instance as any).repo.countJobs() as number);

/** 失敗の通知先を設定へ流し込む, 実際はenqueueに同梱されて届く */
const configure = (name: string) => shard(name).configure({ failureBinding: NOTIFY });

describe('失敗したジョブの通知(#30)', () => {
	it('終端の失敗を通知先へ投入する', async () => {
		const sent: DispatchMessage[] = [];
		await install('FAIL1#0', sent);
		await configure('FAIL1#0');

		const jobId = await shard('FAIL1#0').enqueue({ binding: 'FAIL1', payload: {}, maxAttempts: 1 });
		await runDurableObjectAlarm(shard('FAIL1#0'));
		// 試行を使い切って失敗させる
		await shard('FAIL1#0').report(sent[0]!.jobId, { ok: false, error: 'boom' });
		await runDurableObjectAlarm(shard('FAIL1#0'));

		const notice = await payloadOf(noticeIdOf(jobId, 1));
		expect(notice).toMatchObject({
			jobId,
			binding: 'FAIL1',
			state: 'FAILED',
			attempts: 1,
			maxAttempts: 1,
			runId: null,
			nodeId: null,
		});
		expect(notice?.error).toContain('boom');
	});

	it('再試行で回復する途中の失敗は通知しない', async () => {
		const sent: DispatchMessage[] = [];
		await install('FAIL2#0', sent);
		await configure('FAIL2#0');
		// DOのストレージはテストを跨いで残るので, 増えた分で見る
		const before = await countOf(`${NOTIFY}#0`);

		await shard('FAIL2#0').enqueue({ binding: 'FAIL2', payload: {}, maxAttempts: 3 });
		await runDurableObjectAlarm(shard('FAIL2#0'));
		// 1回目の失敗, まだ試行が残るのでSCHEDULEDへ戻る
		await shard('FAIL2#0').report(sent[0]!.jobId, { ok: false, error: 'retry me' });
		await runDurableObjectAlarm(shard('FAIL2#0'));

		expect(await countOf(`${NOTIFY}#0`)).toBe(before);
	});

	it('通知先を設定していなければ何も投入しない', async () => {
		const sent: DispatchMessage[] = [];
		await install('FAIL3#0', sent);
		const before = await countOf(`${NOTIFY}#0`);

		await shard('FAIL3#0').enqueue({ binding: 'FAIL3', payload: {}, maxAttempts: 1 });
		await runDurableObjectAlarm(shard('FAIL3#0'));
		await shard('FAIL3#0').report(sent[0]!.jobId, { ok: false, error: 'boom' });
		await runDurableObjectAlarm(shard('FAIL3#0'));

		expect(await countOf(`${NOTIFY}#0`)).toBe(before);
	});

	it('通知そのものの失敗は通知しない', async () => {
		// 循環すると失敗のたびに新しい通知が生まれ, 止まらなくなる
		const sent: DispatchMessage[] = [];
		await install(`${NOTIFY}#0`, sent);
		await configure(`${NOTIFY}#0`);
		const before = await countOf(`${NOTIFY}#0`);

		await shard(`${NOTIFY}#0`).enqueue({ binding: NOTIFY, payload: {}, maxAttempts: 1 });
		await runDurableObjectAlarm(shard(`${NOTIFY}#0`));
		await shard(`${NOTIFY}#0`).report(sent[0]!.jobId, { ok: false, error: 'notification failed' });
		await runDurableObjectAlarm(shard(`${NOTIFY}#0`));

		// 投入した1件だけが増える, その失敗から新しい通知は生まれない
		expect(await countOf(`${NOTIFY}#0`)).toBe(before + 1);
	});

	it('同じ失敗を二度積んでも通知は増えない', async () => {
		const sent: DispatchMessage[] = [];
		await install('FAIL4#0', sent);
		await configure('FAIL4#0');

		const jobId = await shard('FAIL4#0').enqueue({ binding: 'FAIL4', payload: {}, maxAttempts: 1 });
		await runDurableObjectAlarm(shard('FAIL4#0'));
		await shard('FAIL4#0').report(sent[0]!.jobId, { ok: false, error: 'boom' });
		await runDurableObjectAlarm(shard('FAIL4#0'));
		const after = await countOf(`${NOTIFY}#0`);

		// 送信の後で落ちた場合と同じ状況, カーソルが進まず同じ通知が再送される
		await runInDurableObject(shard('FAIL4#0'), (instance) => {
			(instance as any).repo.db
				.insert(failureNotify)
				.values({ jobId, payload: JSON.stringify({ jobId, binding: 'FAIL4', state: 'FAILED', attempts: 1 }) })
				.run();
		});
		await runDurableObjectAlarm(shard('FAIL4#0'));

		// 決定的なIDなので既存が返り, 通知先のジョブは増えない(ADR-0029)
		expect(await countOf(`${NOTIFY}#0`)).toBe(after);
		expect(await payloadOf(noticeIdOf(jobId, 1))).toBeDefined();
	});

	it('flowと定期実行が投入するshardにも宛先が届く', async () => {
		// 投入の経路ごとにクライアントが別なので, 配線が抜けるとその経路の失敗だけ捨てられる
		const runNamespace = env.RUN as unknown as DurableObjectNamespace<RunFace>;
		await runNamespace.get(runNamespace.idFromName('GREETINGS:notify-wiring')).start({ flow: 'GREETINGS', input: { prefix: 'wiring' } });

		const schedulerNamespace = env.SCHEDULER as unknown as DurableObjectNamespace<SchedulerFace>;
		const scheduler = schedulerNamespace.get(schedulerNamespace.idFromName('scheduler'));
		await scheduler.sync();
		// 最短の定義が1分間隔なので, 発火させるには時計を進める
		const ahead = Date.now() + 2 * 60_000;
		await runInDurableObject(scheduler, (instance) => void ((instance as any).clock = { now: () => ahead }));
		await runDurableObjectAlarm(scheduler);

		// Run DOはlistへ, Scheduler DOはpoll-namesとping-helloへ投入する
		expect(await settingsOf('ListNames#0')).toMatchObject({ failureBinding: NOTIFY });
		expect(await settingsOf('Hello#0')).toMatchObject({ failureBinding: NOTIFY });
	});

	it('宛先を持たない設定が届いても宛先は消えない', async () => {
		// 共通設定を持たないクライアントからの投入で宛先が消えると, 以降の失敗が捨てられる
		const sent: DispatchMessage[] = [];
		await install('FAIL5#0', sent);
		await shard('FAIL5#0').enqueueMany([{ binding: 'FAIL5', payload: {}, maxAttempts: 1 }], { failureBinding: NOTIFY });
		// 宛先を含まずpolicyだけを持つ設定
		await shard('FAIL5#0').enqueueMany([{ binding: 'FAIL5', payload: {}, maxAttempts: 1 }], { policy: { concurrency: 5 } });

		await runDurableObjectAlarm(shard('FAIL5#0'));
		await shard('FAIL5#0').report(sent[0]!.jobId, { ok: false, error: 'boom' });
		await runDurableObjectAlarm(shard('FAIL5#0'));

		expect(await payloadOf(noticeIdOf(sent[0]!.jobId, 1))).toBeDefined();
	});
});
