import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { DispatchMessage } from '../../src/do/job-shard.js';
import type { SettledNotice, SettledTarget } from '../../src/core/types.js';
import { embedJobId } from '../../src/core/ids.js';

const T0 = 2_600_000_000_000;
const TARGET = 'NotifySettled';
const FAILURE = 'NotifyFailure';

const shard = (name: string) => env.JOB_SHARD.get(env.JOB_SHARD.idFromName(name));

// 実キューはconsumer実行で状態変化
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

const payloadOf = (shardName: string, jobId: string) =>
	runInDurableObject(shard(shardName), (instance) => {
		const row = (instance as any).repo.find(jobId) as { payload: string } | undefined;
		return row ? (JSON.parse(row.payload) as SettledNotice) : undefined;
	});

const noticeIdOf = (jobId: string, attempts: number, state: string) => `${TARGET}#0:settled-${embedJobId(jobId)}-${attempts}-${state}`;

const countOf = (name: string) => runInDurableObject(shard(name), (instance) => (instance as any).repo.countJobs() as number);

const settledRowsOf = (name: string) =>
	runInDurableObject(shard(name), (instance) => (instance as any).repo.countSettledNotify() as number);

// 実運用ではenqueueに同梱
const configure = (name: string, states: SettledTarget['states']) => shard(name).configure({ settled: { binding: TARGET, states } });

// RPC型はブランド継承が必要
interface RunFace extends Rpc.DurableObjectBranded {
	start(input: { flow: string; input: unknown }): Promise<unknown>;
}
interface SchedulerFace extends Rpc.DurableObjectBranded {
	sync(): Promise<void>;
}

const targetOf = (name: string) =>
	runInDurableObject(shard(name), (instance) => {
		const raw = (instance as any).repo.readSetting('settled_target') as string | undefined;
		return raw !== undefined ? (JSON.parse(raw) as SettledTarget) : undefined;
	});

describe('終端に達したジョブの通知(#96)', () => {
	it('COMPLETEDを対象にすると完了を通知先へ投入する', async () => {
		const sent: DispatchMessage[] = [];
		await install('SET1#0', sent);
		await configure('SET1#0', ['COMPLETED']);

		const jobId = await shard('SET1#0').enqueue({ binding: 'SET1', payload: {}, maxAttempts: 1 });
		await runDurableObjectAlarm(shard('SET1#0'));
		await shard('SET1#0').report(sent[0]!.jobId, { ok: true, result: { greeting: 'hi' } });
		await runDurableObjectAlarm(shard('SET1#0'));

		const notice = await payloadOf(`${TARGET}#0`, noticeIdOf(jobId, 1, 'completed'));
		expect(notice).toMatchObject({
			jobId,
			binding: 'SET1',
			state: 'COMPLETED',
			attempts: 1,
			maxAttempts: 1,
			error: null,
			result: { greeting: 'hi' },
			runId: null,
			nodeId: null,
			settledAt: T0,
		});
	});

	it('statesに無い終端は記録も投入もしない', async () => {
		const sent: DispatchMessage[] = [];
		await install('SET2#0', sent);
		await configure('SET2#0', ['FAILED']);
		const before = await countOf(`${TARGET}#0`);

		await shard('SET2#0').enqueue({ binding: 'SET2', payload: {}, maxAttempts: 1 });
		await runDurableObjectAlarm(shard('SET2#0'));
		await shard('SET2#0').report(sent[0]!.jobId, { ok: true });
		await runDurableObjectAlarm(shard('SET2#0'));

		expect(await settledRowsOf('SET2#0')).toBe(0);
		expect(await countOf(`${TARGET}#0`)).toBe(before);
	});

	it('onFailureと併用すると失敗は両方の宛先へ届く', async () => {
		const sent: DispatchMessage[] = [];
		await install('SET3#0', sent);
		await shard('SET3#0').configure({ failureBinding: FAILURE, settled: { binding: TARGET, states: ['FAILED'] } });

		const jobId = await shard('SET3#0').enqueue({ binding: 'SET3', payload: {}, maxAttempts: 1 });
		await runDurableObjectAlarm(shard('SET3#0'));
		await shard('SET3#0').report(sent[0]!.jobId, { ok: false, error: 'boom' });
		await runDurableObjectAlarm(shard('SET3#0'));

		expect(await payloadOf(`${TARGET}#0`, noticeIdOf(jobId, 1, 'failed'))).toMatchObject({ jobId, state: 'FAILED' });
		expect(await payloadOf(`${FAILURE}#0`, `${FAILURE}#0:failure-${embedJobId(jobId)}-1`)).toMatchObject({ jobId, state: 'FAILED' });
	});

	it('宛先自身の遷移は記録しない', async () => {
		// COMPLETED対象時は通知ジョブの完了で次の通知が無限に発生
		const sent: DispatchMessage[] = [];
		await install(`${TARGET}#0`, sent);
		await configure(`${TARGET}#0`, ['COMPLETED', 'FAILED']);
		const before = await countOf(`${TARGET}#0`);

		await shard(`${TARGET}#0`).enqueue({ binding: TARGET, payload: {}, maxAttempts: 1 });
		await runDurableObjectAlarm(shard(`${TARGET}#0`));
		await shard(`${TARGET}#0`).report(sent[0]!.jobId, { ok: true });
		await runDurableObjectAlarm(shard(`${TARGET}#0`));

		// 投入1件のみ増加, その完了から新規通知なし
		expect(await settledRowsOf(`${TARGET}#0`)).toBe(0);
		expect(await countOf(`${TARGET}#0`)).toBe(before + 1);
	});

	it('onFailure宛先の遷移は投入しない', async () => {
		// 失敗通知ジョブの終端を通知すると2宛先の相互連鎖が発生
		const sent: DispatchMessage[] = [];
		await install(`${FAILURE}#0`, sent);
		await shard(`${FAILURE}#0`).configure({ failureBinding: FAILURE, settled: { binding: TARGET, states: ['FAILED'] } });
		const before = await countOf(`${TARGET}#0`);

		await shard(`${FAILURE}#0`).enqueue({ binding: FAILURE, payload: {}, maxAttempts: 1 });
		await runDurableObjectAlarm(shard(`${FAILURE}#0`));
		await shard(`${FAILURE}#0`).report(sent[0]!.jobId, { ok: false, error: 'notification failed' });
		await runDurableObjectAlarm(shard(`${FAILURE}#0`));

		expect(await countOf(`${TARGET}#0`)).toBe(before);
	});

	it('設定前の遷移は記録しない', async () => {
		const sent: DispatchMessage[] = [];
		await install('SET4#0', sent);
		const before = await countOf(`${TARGET}#0`);

		await shard('SET4#0').enqueue({ binding: 'SET4', payload: {}, maxAttempts: 1 });
		await runDurableObjectAlarm(shard('SET4#0'));
		await shard('SET4#0').report(sent[0]!.jobId, { ok: false, error: 'boom' });
		await runDurableObjectAlarm(shard('SET4#0'));

		expect(await settledRowsOf('SET4#0')).toBe(0);
		expect(await countOf(`${TARGET}#0`)).toBe(before);
	});

	it('設定の解除が届くと通知しなくなる', async () => {
		const sent: DispatchMessage[] = [];
		await install('SET5#0', sent);
		await shard('SET5#0').enqueueMany([{ binding: 'SET5', payload: {}, maxAttempts: 1 }], {
			settled: { binding: TARGET, states: ['FAILED'] },
		});
		await shard('SET5#0').enqueueMany([{ binding: 'SET5', payload: {}, maxAttempts: 1 }], { settled: null });
		const before = await countOf(`${TARGET}#0`);

		await runDurableObjectAlarm(shard('SET5#0'));
		await shard('SET5#0').report(sent[0]!.jobId, { ok: false, error: 'boom' });
		await runDurableObjectAlarm(shard('SET5#0'));

		expect(await countOf(`${TARGET}#0`)).toBe(before);
	});

	it('同じ通知を二度積んでも投入は増えない', async () => {
		const sent: DispatchMessage[] = [];
		await install('SET6#0', sent);
		await configure('SET6#0', ['COMPLETED']);

		const jobId = await shard('SET6#0').enqueue({ binding: 'SET6', payload: {}, maxAttempts: 1 });
		await runDurableObjectAlarm(shard('SET6#0'));
		await shard('SET6#0').report(sent[0]!.jobId, { ok: true });
		await runDurableObjectAlarm(shard('SET6#0'));
		const after = await countOf(`${TARGET}#0`);

		// 送信後中断を再現, カーソル未更新で同じ通知を再送
		await runInDurableObject(shard('SET6#0'), (instance) => {
			((instance as any).repo.sql as SqlStorage).exec(
				`INSERT INTO settled_notify (job_id, payload) VALUES (?, ?)`,
				jobId,
				JSON.stringify({ jobId, binding: 'SET6', state: 'COMPLETED', attempts: 1 }),
			);
		});
		await runDurableObjectAlarm(shard('SET6#0'));

		expect(await countOf(`${TARGET}#0`)).toBe(after);
		expect(await payloadOf(`${TARGET}#0`, noticeIdOf(jobId, 1, 'completed'))).toBeDefined();
	});

	it('リトライ後の別の終端は別の通知として届く', async () => {
		// attempts同値でもIDに状態を含め, STALLED後のCANCELLEDも個別通知
		const sent: DispatchMessage[] = [];
		await install('SET7#0', sent);
		await configure('SET7#0', ['STALLED', 'CANCELLED']);

		// at-most-onceは二重実行回避でSTALLED停止(ADR-0007)
		const jobId = await shard('SET7#0').enqueue({
			binding: 'SET7',
			payload: {},
			maxAttempts: 3,
			timeoutMs: 1_000,
			guarantee: 'at-most-once',
		});
		await runDurableObjectAlarm(shard('SET7#0'));
		// 無応答で期限と猶予経過後にreaper処理
		await runInDurableObject(shard('SET7#0'), (instance) => void ((instance as any).clock = { now: () => T0 + 120_000 }));
		await runDurableObjectAlarm(shard('SET7#0'));

		await shard('SET7#0').retry(jobId);
		await shard('SET7#0').cancel(jobId);
		await runDurableObjectAlarm(shard('SET7#0'));

		// 報告なしで試行未計上, 理由もnull
		expect(await payloadOf(`${TARGET}#0`, noticeIdOf(jobId, 0, 'stalled'))).toMatchObject({ jobId, state: 'STALLED', error: null });
		expect(await payloadOf(`${TARGET}#0`, noticeIdOf(jobId, 0, 'cancelled'))).toMatchObject({ jobId, state: 'CANCELLED' });
	});

	it('結果の無い完了はresultがnullになる', async () => {
		const sent: DispatchMessage[] = [];
		await install('SET8#0', sent);
		await configure('SET8#0', ['COMPLETED']);

		const jobId = await shard('SET8#0').enqueue({ binding: 'SET8', payload: {}, maxAttempts: 1 });
		await runDurableObjectAlarm(shard('SET8#0'));
		await shard('SET8#0').report(sent[0]!.jobId, { ok: true });
		await runDurableObjectAlarm(shard('SET8#0'));

		expect(await payloadOf(`${TARGET}#0`, noticeIdOf(jobId, 1, 'completed'))).toMatchObject({ jobId, result: null });
	});

	it('flowと定期実行が投入するshardにも設定が届く', async () => {
		// 経路ごとに別クライアント, 設定欠落経路の終端は通知対象外
		const runNamespace = env.RUN as unknown as DurableObjectNamespace<RunFace>;
		await runNamespace
			.get(runNamespace.idFromName('GREETINGS:settled-wiring'))
			.start({ flow: 'GREETINGS', input: { prefix: 'settled-wiring' } });

		const schedulerNamespace = env.SCHEDULER as unknown as DurableObjectNamespace<SchedulerFace>;
		const scheduler = schedulerNamespace.get(schedulerNamespace.idFromName('scheduler'));
		await scheduler.sync();
		// 最短定義は1分間隔, 発火用に時計を前進
		const ahead = Date.now() + 2 * 60_000;
		await runInDurableObject(scheduler, (instance) => void ((instance as any).clock = { now: () => ahead }));
		await runDurableObjectAlarm(scheduler);

		// Run DOはlistへ, Scheduler DOはpoll-namesとping-helloへ投入
		expect((await targetOf('ListNames#0'))?.binding).toBe(TARGET);
		expect((await targetOf('Hello#0'))?.binding).toBe(TARGET);
	});
});
