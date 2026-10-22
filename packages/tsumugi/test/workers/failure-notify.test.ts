import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { DispatchMessage } from '../../src/do/job-shard.js';
import type { FailureNotice } from '../../src/core/types.js';
import { failureNotify } from '../../src/do/tables.js';
import { embedJobId } from '../../src/core/ids.js';

const T0 = 2_500_000_000_000;
const NOTIFY = 'NotifyFailure';

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

const payloadOf = (jobId: string) =>
	runInDurableObject(shard(`${NOTIFY}#0`), (instance) => {
		const row = (instance as any).repo.find(jobId) as { payload: string } | undefined;
		return row ? (JSON.parse(row.payload) as FailureNotice) : undefined;
	});

const noticeIdOf = (jobId: string, attempts: number) => `${NOTIFY}#0:failure-${embedJobId(jobId)}-${attempts}`;

// RPC型はブランド継承が必要
interface RunFace extends Rpc.DurableObjectBranded {
	start(input: { flow: string; input: unknown }): Promise<unknown>;
}
interface SchedulerFace extends Rpc.DurableObjectBranded {
	sync(): Promise<void>;
}

const bindingOf = (name: string) =>
	runInDurableObject(shard(name), (instance) => (instance as any).repo.readSetting('failure_binding') as string | undefined);

const countOf = (name: string) => runInDurableObject(shard(name), (instance) => (instance as any).repo.countJobs() as number);

// 実運用ではenqueueに同梱
const configure = (name: string) => shard(name).configure({ failureBinding: NOTIFY });

describe('失敗したジョブの通知(#30)', () => {
	it('終端の失敗を通知先へ投入する', async () => {
		const sent: DispatchMessage[] = [];
		await install('FAIL1#0', sent);
		await configure('FAIL1#0');

		const jobId = await shard('FAIL1#0').enqueue({ binding: 'FAIL1', payload: {}, maxAttempts: 1 });
		await runDurableObjectAlarm(shard('FAIL1#0'));
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
		// DOストレージはテスト間で残存、増分で判定
		const before = await countOf(`${NOTIFY}#0`);

		await shard('FAIL2#0').enqueue({ binding: 'FAIL2', payload: {}, maxAttempts: 3 });
		await runDurableObjectAlarm(shard('FAIL2#0'));
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
		// 循環時は失敗ごとに新規通知が無限に発生
		const sent: DispatchMessage[] = [];
		await install(`${NOTIFY}#0`, sent);
		await configure(`${NOTIFY}#0`);
		const before = await countOf(`${NOTIFY}#0`);

		await shard(`${NOTIFY}#0`).enqueue({ binding: NOTIFY, payload: {}, maxAttempts: 1 });
		await runDurableObjectAlarm(shard(`${NOTIFY}#0`));
		await shard(`${NOTIFY}#0`).report(sent[0]!.jobId, { ok: false, error: 'notification failed' });
		await runDurableObjectAlarm(shard(`${NOTIFY}#0`));

		// 投入1件のみ増加, その失敗から新規通知なし
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

		// 送信後中断を再現, カーソル未更新で同じ通知を再送
		await runInDurableObject(shard('FAIL4#0'), (instance) => {
			(instance as any).repo.db
				.insert(failureNotify)
				.values({ jobId, payload: JSON.stringify({ jobId, binding: 'FAIL4', state: 'FAILED', attempts: 1 }) })
				.run();
		});
		await runDurableObjectAlarm(shard('FAIL4#0'));

		expect(await countOf(`${NOTIFY}#0`)).toBe(after);
		expect(await payloadOf(noticeIdOf(jobId, 1))).toBeDefined();
	});

	it('回収された失敗も通知する', async () => {
		const sent: DispatchMessage[] = [];
		await install('FAIL6#0', sent);
		await configure('FAIL6#0');

		// at-most-onceは二重実行回避でSTALLED停止(ADR-0007)
		const jobId = await shard('FAIL6#0').enqueue({
			binding: 'FAIL6',
			payload: {},
			maxAttempts: 3,
			timeoutMs: 1_000,
			guarantee: 'at-most-once',
		});
		await runDurableObjectAlarm(shard('FAIL6#0'));
		// 無応答で期限と猶予経過後にreaper処理
		await runInDurableObject(shard('FAIL6#0'), (instance) => void ((instance as any).clock = { now: () => T0 + 120_000 }));
		await runDurableObjectAlarm(shard('FAIL6#0'));

		// 報告なしで試行未計上
		expect(await payloadOf(noticeIdOf(jobId, 0))).toMatchObject({ jobId, binding: 'FAIL6', state: 'STALLED', attempts: 0 });
	});

	it('流量を固定したshardにも後から追加した宛先が届く', async () => {
		// policyのpinと同じ扱いでは流量制限済みshardへ後続宛先が未反映
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
		// ローカル部のみの構築では利用者指定IDの2件の失敗が1件に統合
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
		// onFailure削除後, 既存shardの旧宛先への送信防止
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
		// 投入経路ごとに別クライアント, 設定漏れ時はその経路の失敗のみ破棄
		const runNamespace = env.RUN as unknown as DurableObjectNamespace<RunFace>;
		await runNamespace.get(runNamespace.idFromName('GREETINGS:notify-wiring')).start({ flow: 'GREETINGS', input: { prefix: 'wiring' } });

		const schedulerNamespace = env.SCHEDULER as unknown as DurableObjectNamespace<SchedulerFace>;
		const scheduler = schedulerNamespace.get(schedulerNamespace.idFromName('scheduler'));
		await scheduler.sync();
		// 最短定義は1分間隔, 発火用に時計を前進
		const ahead = Date.now() + 2 * 60_000;
		await runInDurableObject(scheduler, (instance) => void ((instance as any).clock = { now: () => ahead }));
		await runDurableObjectAlarm(scheduler);

		// Run DOはlistへ, Scheduler DOはpoll-namesとping-helloへ投入
		expect(await bindingOf('ListNames#0')).toBe(NOTIFY);
		expect(await bindingOf('Hello#0')).toBe(NOTIFY);
	});

	it('宛先を持たない設定が届いても宛先は消えない', async () => {
		// 共通設定なしクライアントの投入で宛先削除時、以降の失敗を破棄
		const sent: DispatchMessage[] = [];
		await install('FAIL5#0', sent);
		await shard('FAIL5#0').enqueueMany([{ binding: 'FAIL5', payload: {}, maxAttempts: 1 }], { failureBinding: NOTIFY });
		await shard('FAIL5#0').enqueueMany([{ binding: 'FAIL5', payload: {}, maxAttempts: 1 }], { policy: { concurrency: 5 } });

		await runDurableObjectAlarm(shard('FAIL5#0'));
		await shard('FAIL5#0').report(sent[0]!.jobId, { ok: false, error: 'boom' });
		await runDurableObjectAlarm(shard('FAIL5#0'));

		expect(await payloadOf(noticeIdOf(sent[0]!.jobId, 1))).toBeDefined();
	});

	it('D1への投影が失敗しても失敗の通知を投入し5秒後に再試行する', async () => {
		const sent: DispatchMessage[] = [];
		await install('FAIL7#0', sent);
		await configure('FAIL7#0');
		const jobId = await shard('FAIL7#0').enqueue({ binding: 'FAIL7', payload: {}, maxAttempts: 1 });
		await runDurableObjectAlarm(shard('FAIL7#0'));
		await shard('FAIL7#0').report(sent[0]!.jobId, { ok: false, error: 'boom' });

		const alarm = await runInDurableObject(shard('FAIL7#0'), async (instance) => {
			const env = (instance as any).env;
			const original = env.TSUMUGI_DB;
			env.TSUMUGI_DB = {
				batch: async () => {
					throw new Error('D1 unavailable');
				},
				prepare: () => {
					throw new Error('D1 unavailable');
				},
			};
			try {
				await (instance as any).ctx.storage.deleteAlarm();
				await (instance as any).alarm();
				return (await (instance as any).ctx.storage.getAlarm()) as number | null;
			} finally {
				env.TSUMUGI_DB = original;
			}
		});

		expect(await payloadOf(noticeIdOf(jobId, 1))).toBeDefined();
		// 即時再起動では障害中にtick反復
		expect(alarm).toBe(T0 + 5_000);

		await runDurableObjectAlarm(shard('FAIL7#0'));
		const remaining = await runInDurableObject(shard('FAIL7#0'), (instance) => (instance as any).repo.countOutbox() as number);
		expect(remaining).toBe(0);
		const row = await env.TSUMUGI_DB.prepare('SELECT state FROM job WHERE id = ?').bind(jobId).first<{ state: string }>();
		expect(row?.state).toBe('FAILED');
	});

	it('退避後の最初の呼び出しがresetPolicyでも宛先を保持する', async () => {
		const sent: DispatchMessage[] = [];
		await install('FAIL6#0', sent);
		await configure('FAIL6#0');

		// 同一ストレージで新インスタンス生成し退避後を再現
		const jobId = await runInDurableObject(shard('FAIL6#0'), async (instance, state) => {
			const fresh = new (instance.constructor as any)(state, (instance as any).env);
			fresh.clock = (instance as any).clock;
			await fresh.resetPolicy();
			const id = (await fresh.enqueue({ binding: 'FAIL6', payload: {}, maxAttempts: 1 })) as string;
			await fresh.alarm();
			await fresh.report(sent[0]!.jobId, { ok: false, error: 'boom' });
			await fresh.alarm();
			return id;
		});

		expect(await payloadOf(noticeIdOf(jobId, 1))).toBeDefined();
	});
});
