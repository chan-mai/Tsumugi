import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { DispatchMessage } from '../../src/do/job-shard.js';
import type { FailureNotice } from '../../src/core/types.js';
import { failureNotify } from '../../src/do/tables.js';
import { embedJobId } from '../../src/core/ids.js';

/**
 * 失敗したジョブの通知(#30)
 *
 * 終端の失敗だけを通知先のbindingへジョブとして投入
 * 通知そのものの失敗は対象外, 自分を呼び続ける循環の防止
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

/** 通知先へ届いたジョブのpayload, 宛先はshard 0に固定 */
const payloadOf = (jobId: string) =>
	runInDurableObject(shard(`${NOTIFY}#0`), (instance) => {
		const row = (instance as any).repo.find(jobId) as { payload: string } | undefined;
		return row ? (JSON.parse(row.payload) as FailureNotice) : undefined;
	});

/** 通知として投入されるジョブのID, 元のID全体と試行回数から決まる */
const noticeIdOf = (jobId: string, attempts: number) => `${NOTIFY}#0:failure-${embedJobId(jobId)}-${attempts}`;

/** flowと定期実行の起動口, RPCの型はブランドを継承する必要がある */
interface RunFace extends Rpc.DurableObjectBranded {
	start(input: { flow: string; input: unknown }): Promise<unknown>;
}
interface SchedulerFace extends Rpc.DurableObjectBranded {
	sync(): Promise<void>;
}

/** DOが保存した宛先, 投入の経路ごとに届いているかを見る */
const bindingOf = (name: string) =>
	runInDurableObject(shard(name), (instance) => (instance as any).repo.readSetting('failure_binding') as string | undefined);

const countOf = (name: string) => runInDurableObject(shard(name), (instance) => (instance as any).repo.countJobs() as number);

/** 失敗の通知先を設定へ書き込む, 実際はenqueueに同梱されて届く */
const configure = (name: string) => shard(name).configure({ failureBinding: NOTIFY });

describe('失敗したジョブの通知(#30)', () => {
	it('終端の失敗を通知先へ投入する', async () => {
		const sent: DispatchMessage[] = [];
		await install('FAIL1#0', sent);
		await configure('FAIL1#0');

		const jobId = await shard('FAIL1#0').enqueue({ binding: 'FAIL1', payload: {}, maxAttempts: 1 });
		await runDurableObjectAlarm(shard('FAIL1#0'));
		// 試行を使い切って失敗させる状況
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
		// DOのストレージはテストを跨いで残り、増えた分で判定
		const before = await countOf(`${NOTIFY}#0`);

		await shard('FAIL2#0').enqueue({ binding: 'FAIL2', payload: {}, maxAttempts: 3 });
		await runDurableObjectAlarm(shard('FAIL2#0'));
		// 1回目の失敗, まだ試行が残るためSCHEDULEDへ戻る
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

		// 送信の後で中断した場合と同じ状況, カーソルが進まず同じ通知が再送
		await runInDurableObject(shard('FAIL4#0'), (instance) => {
			(instance as any).repo.db
				.insert(failureNotify)
				.values({ jobId, payload: JSON.stringify({ jobId, binding: 'FAIL4', state: 'FAILED', attempts: 1 }) })
				.run();
		});
		await runDurableObjectAlarm(shard('FAIL4#0'));

		// 決定的なIDのため既存が返り, 通知先のジョブは増えない(ADR-0029)
		expect(await countOf(`${NOTIFY}#0`)).toBe(after);
		expect(await payloadOf(noticeIdOf(jobId, 1))).toBeDefined();
	});

	it('回収された失敗も通知する', async () => {
		// 終端はreportによる失敗だけではない, reaperの中断も通知の対象
		const sent: DispatchMessage[] = [];
		await install('FAIL6#0', sent);
		await configure('FAIL6#0');

		// at-most-onceは再投入が二重実行になり得るためSTALLEDで止まる(ADR-0007)
		const jobId = await shard('FAIL6#0').enqueue({
			binding: 'FAIL6',
			payload: {},
			maxAttempts: 3,
			timeoutMs: 1_000,
			guarantee: 'at-most-once',
		});
		await runDurableObjectAlarm(shard('FAIL6#0'));
		// 応答が無いまま期限と猶予を過ぎると回収
		await runInDurableObject(shard('FAIL6#0'), (instance) => void ((instance as any).clock = { now: () => T0 + 120_000 }));
		await runDurableObjectAlarm(shard('FAIL6#0'));

		// 報告が無く試行は計上されていない
		expect(await payloadOf(noticeIdOf(jobId, 0))).toMatchObject({ jobId, binding: 'FAIL6', state: 'STALLED', attempts: 0 });
	});

	it('流量を固定したshardにも後から追加した宛先が届く', async () => {
		// 宛先をpolicyのpinと同じ扱いにすると、一度流量を制限したshardへ後から追加した宛先が永久に届かない
		const sent: DispatchMessage[] = [];
		await install('FAIL7#0', sent);
		await shard('FAIL7#0').configure({ policy: { concurrency: 10 } });
		await shard('FAIL7#0').enqueueMany([{ binding: 'FAIL7', payload: {}, maxAttempts: 1 }], { failureBinding: NOTIFY });

		await runDurableObjectAlarm(shard('FAIL7#0'));
		await shard('FAIL7#0').report(sent[0]!.jobId, { ok: false, error: 'boom' });
		await runDurableObjectAlarm(shard('FAIL7#0'));

		expect(await payloadOf(noticeIdOf(sent[0]!.jobId, 1))).toBeDefined();
	});

	it('bindingが違えばローカル部が同じでも別の通知になる', async () => {
		// ローカル部だけで構築すると、利用者がIDを指定した2件の失敗が1件に統合されてしまう
		const sent: DispatchMessage[] = [];
		await install('FAIL8#0', sent);
		await install('FAIL9#0', sent);
		await configure('FAIL8#0');
		await configure('FAIL9#0');

		const first = await shard('FAIL8#0').enqueue({ binding: 'FAIL8', payload: {}, maxAttempts: 1, id: 'FAIL8#0:same' });
		const second = await shard('FAIL9#0').enqueue({ binding: 'FAIL9', payload: {}, maxAttempts: 1, id: 'FAIL9#0:same' });
		await runDurableObjectAlarm(shard('FAIL8#0'));
		await runDurableObjectAlarm(shard('FAIL9#0'));
		await shard('FAIL8#0').report(first, { ok: false, error: 'boom' });
		await shard('FAIL9#0').report(second, { ok: false, error: 'boom' });
		await runDurableObjectAlarm(shard('FAIL8#0'));
		await runDurableObjectAlarm(shard('FAIL9#0'));

		expect(await payloadOf(noticeIdOf(first, 1))).toMatchObject({ jobId: first, binding: 'FAIL8' });
		expect(await payloadOf(noticeIdOf(second, 1))).toMatchObject({ jobId: second, binding: 'FAIL9' });
	});

	it('宛先の解除が届くと通知しなくなる', async () => {
		// onFailureを設定から外した場合, 既存のshardが古い宛先へ送り続けてはいけない
		const sent: DispatchMessage[] = [];
		await install('FAIL10#0', sent);
		await shard('FAIL10#0').enqueueMany([{ binding: 'FAIL10', payload: {}, maxAttempts: 1 }], { failureBinding: NOTIFY });
		await shard('FAIL10#0').enqueueMany([{ binding: 'FAIL10', payload: {}, maxAttempts: 1 }], { failureBinding: null });
		const before = await countOf(`${NOTIFY}#0`);

		await runDurableObjectAlarm(shard('FAIL10#0'));
		await shard('FAIL10#0').report(sent[0]!.jobId, { ok: false, error: 'boom' });
		await runDurableObjectAlarm(shard('FAIL10#0'));

		expect(await countOf(`${NOTIFY}#0`)).toBe(before);
	});

	it('flowと定期実行が投入するshardにも宛先が届く', async () => {
		// 投入の経路ごとにクライアントが別で、設定が抜けるとその経路の失敗だけ破棄
		const runNamespace = env.RUN as unknown as DurableObjectNamespace<RunFace>;
		await runNamespace.get(runNamespace.idFromName('GREETINGS:notify-wiring')).start({ flow: 'GREETINGS', input: { prefix: 'wiring' } });

		const schedulerNamespace = env.SCHEDULER as unknown as DurableObjectNamespace<SchedulerFace>;
		const scheduler = schedulerNamespace.get(schedulerNamespace.idFromName('scheduler'));
		await scheduler.sync();
		// 最短の定義が1分間隔, 発火のために時計を前進
		const ahead = Date.now() + 2 * 60_000;
		await runInDurableObject(scheduler, (instance) => void ((instance as any).clock = { now: () => ahead }));
		await runDurableObjectAlarm(scheduler);

		// Run DOはlistへ, Scheduler DOはpoll-namesとping-helloへ投入
		expect(await bindingOf('ListNames#0')).toBe(NOTIFY);
		expect(await bindingOf('Hello#0')).toBe(NOTIFY);
	});

	it('宛先を持たない設定が届いても宛先は消えない', async () => {
		// 共通設定を持たないクライアントからの投入で宛先が消えると、以降の失敗が破棄
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
