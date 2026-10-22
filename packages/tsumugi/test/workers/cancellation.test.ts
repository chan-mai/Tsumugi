import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/do/clock.js';
import type { DispatchMessage } from '../../src/do/job-shard.js';
import type { SettledNotice } from '../../src/core/types.js';

// 確定はperformerの報告か要求後reaperGraceMs(既定30秒)経過時

const T0 = 2_700_000_000_000;
const GRACE = 30_000;

const shard = (name: string) => env.JOB_SHARD.get(env.JOB_SHARD.idFromName(name));

// 実キューはconsumer実行で状態変化
async function install(name: string) {
	const sent: DispatchMessage[] = [];
	await runInDurableObject(shard(name), (instance) => {
		(instance as any).env.TSUMUGI_QUEUE = {
			send: async (body: DispatchMessage) => void sent.push(body),
			sendBatch: async (batch: Iterable<{ body: DispatchMessage }>) => {
				for (const m of batch) sent.push(m.body);
			},
		};
	});
	return sent;
}

// DO再生成で時計が既定へ復帰、操作直前に再設定
const setClock = (name: string, at: number) =>
	runInDurableObject(shard(name), (instance) => void ((instance as any).clock = fixedClock(at)));

type Row = { state: string; attempts: number; result: string | null; cancel_requested_at: number | null } | undefined;
const rowOf = (name: string, jobId: string) => runInDurableObject(shard(name), (instance) => (instance as any).repo.find(jobId) as Row);

async function queued(name: string, options: Record<string, unknown> = {}): Promise<string> {
	await install(name);
	await setClock(name, T0);
	const jobId = await shard(name).enqueue({ binding: name.split('#')[0]!, payload: {}, ...options });
	await runDurableObjectAlarm(shard(name));
	return jobId;
}

describe('取り消し要求(#95)', () => {
	it('SCHEDULEDは従来どおり即時CANCELLED', async () => {
		await install('CX1#0');
		await setClock('CX1#0', T0);
		const jobId = await shard('CX1#0').enqueue({ binding: 'CX1', payload: {}, delayMs: 60_000 });

		expect(await shard('CX1#0').cancel(jobId)).toEqual({ ok: true });
		expect((await rowOf('CX1#0', jobId))?.state).toBe('CANCELLED');
	});

	it('QUEUEDへの取り消しは要求として記録されheartbeatの戻り値に反映される', async () => {
		const jobId = await queued('CX2#0');

		expect(await shard('CX2#0').cancel(jobId)).toEqual({ ok: true, requested: true });
		const row = await rowOf('CX2#0', jobId);
		expect(row?.state).toBe('QUEUED');
		expect(row?.cancel_requested_at).toBe(T0);
		expect(await shard('CX2#0').heartbeat(jobId)).toEqual({ accepted: true, cancelRequested: true });

		await runDurableObjectAlarm(shard('CX2#0'));
		const projected = await env.TSUMUGI_DB.prepare('SELECT cancel_requested_at FROM job WHERE id = ?').bind(jobId).first();
		expect(projected?.cancel_requested_at).toBe(T0);
	});

	it('要求後の失敗報告はリトライせずCANCELLEDへ確定する', async () => {
		const jobId = await queued('CX3#0', { maxAttempts: 3 });
		await shard('CX3#0').cancel(jobId);

		await shard('CX3#0').report(jobId, { ok: false, error: 'cancelled by request' });

		const row = await rowOf('CX3#0', jobId);
		expect(row?.state).toBe('CANCELLED');
		expect(row?.attempts).toBe(1);
	});

	it('要求後の成功報告はCOMPLETEDのまま', async () => {
		// 要求より先に処理完了, 結果も保持(ADR-0052)
		const jobId = await queued('CX4#0');
		await shard('CX4#0').cancel(jobId);

		await shard('CX4#0').report(jobId, { ok: true, result: { done: true } });

		const row = await rowOf('CX4#0', jobId);
		expect(row?.state).toBe('COMPLETED');
		expect(row?.result).toBe('{"done":true}');
	});

	it('無応答は要求からreaperGraceMsの経過でCANCELLEDになる', async () => {
		const jobId = await queued('CX5#0', { timeoutMs: 600_000 });
		await shard('CX5#0').cancel(jobId);

		// 無応答判定(timeout+grace)より早く確定
		await setClock('CX5#0', T0 + GRACE);
		await runDurableObjectAlarm(shard('CX5#0'));
		expect((await rowOf('CX5#0', jobId))?.state).toBe('CANCELLED');
	});

	it('at-most-onceのclaimは要求済みなら実行権を付与せずCANCELLEDにする', async () => {
		const jobId = await queued('CX6#0', { guarantee: 'at-most-once' });
		await shard('CX6#0').cancel(jobId);

		expect(await shard('CX6#0').claim(jobId)).toBe(false);
		expect((await rowOf('CX6#0', jobId))?.state).toBe('CANCELLED');
	});

	it('再要求は冪等, 終端はinvalid-state, 消滅はgone', async () => {
		const jobId = await queued('CX7#0');
		await shard('CX7#0').cancel(jobId);
		expect(await shard('CX7#0').cancel(jobId)).toEqual({ ok: true, requested: true });

		await shard('CX7#0').report(jobId, { ok: true });
		expect(await shard('CX7#0').cancel(jobId)).toEqual({ ok: false, reason: 'invalid-state' });
		expect(await shard('CX7#0').cancel('CX7#0:missing00000000000000000')).toEqual({ ok: false, reason: 'gone' });
	});

	it('手動リトライは要求をクリアして再投入する', async () => {
		const jobId = await queued('CX8#0', { maxAttempts: 1 });
		await shard('CX8#0').report(jobId, { ok: false, error: 'boom' });
		expect((await rowOf('CX8#0', jobId))?.state).toBe('FAILED');
		// 終端行に要求が残存した場合の防御, 公開経路では要求済み終端はCANCELLEDのみ
		await runInDurableObject(shard('CX8#0'), (instance) =>
			(instance as any).repo.sql.exec(`UPDATE job SET cancel_requested_at = ? WHERE id = ?`, T0, jobId),
		);

		expect(await shard('CX8#0').retry(jobId)).toEqual({ ok: true });
		const row = await rowOf('CX8#0', jobId);
		expect(row?.state).toBe('SCHEDULED');
		expect(row?.cancel_requested_at).toBeNull();
	});

	it('要求済みのジョブのrescheduleは拒否される', async () => {
		await install('CX9#0');
		await setClock('CX9#0', T0);
		const jobId = await shard('CX9#0').enqueue({ binding: 'CX9', payload: {}, delayMs: 60_000 });
		// SCHEDULEDへは要求記録なし、reaper処理との競合時の残留を直接再現
		await runInDurableObject(shard('CX9#0'), (instance) =>
			(instance as any).repo.sql.exec(`UPDATE job SET cancel_requested_at = ? WHERE id = ?`, T0, jobId),
		);

		expect(await shard('CX9#0').reschedule(jobId, { runAfter: T0 + 120_000 })).toEqual({ ok: false, reason: 'invalid-state' });

		await runDurableObjectAlarm(shard('CX9#0'));
		await setClock('CX9#0', T0 + 60_000);
		await runDurableObjectAlarm(shard('CX9#0'));
		expect((await rowOf('CX9#0', jobId))?.state).toBe('CANCELLED');
	});

	it('実行中のノードを持つrunの取り消しはジョブの終端通知で確定する', async () => {
		interface RunFace extends Rpc.DurableObjectBranded {
			start(input: { flow: string; input: unknown }): Promise<{ id: string }>;
			cancel(): Promise<{ ok: boolean }>;
			state(): Promise<string | null>;
		}
		await install('ListNames#0');
		await setClock('ListNames#0', T0);
		const runNamespace = env.RUN as unknown as DurableObjectNamespace<RunFace>;
		const run = runNamespace.get(runNamespace.idFromName('GREETINGS:cancel-coop'));
		await run.start({ flow: 'GREETINGS', input: { prefix: 'cancel-coop' } });

		// ノード投入はRun DOのtickで実施, 確定までalarm反復
		let jobId: string | null = null;
		for (let i = 0; i < 10 && jobId === null; i++) {
			await runDurableObjectAlarm(run as never);
			jobId = await runInDurableObject(
				run as never,
				(instance) => ((instance as any).repo.findNode('list')?.job_id ?? null) as string | null,
			);
		}
		// 共有shardに他テストの残留あり、投入までalarm反復
		let jobState: string | undefined;
		for (let i = 0; i < 20 && jobState !== 'QUEUED'; i++) {
			await runDurableObjectAlarm(shard('ListNames#0'));
			jobState = (await rowOf('ListNames#0', jobId!))?.state;
		}
		expect(jobState).toBe('QUEUED');

		expect(await run.cancel()).toEqual({ ok: true });

		// Run DOは実時刻alarmで並行進行, 要求記録はポーリングで待機
		let requestedAt: number | null = null;
		for (let i = 0; i < 20 && requestedAt === null; i++) {
			await runDurableObjectAlarm(run as never);
			await new Promise((resolve) => setTimeout(resolve, 10));
			requestedAt = (await rowOf('ListNames#0', jobId!))?.cancel_requested_at ?? null;
		}
		expect(requestedAt).toBe(T0);
		const nodeState = await runInDurableObject(run as never, (instance) => (instance as any).repo.findNode('list')?.state as string);
		expect(['COMPLETED', 'FAILED', 'CANCELLED', 'SKIPPED']).not.toContain(nodeState);

		await setClock('ListNames#0', T0 + GRACE);
		for (let i = 0; i < 20 && jobState !== 'CANCELLED'; i++) {
			await runDurableObjectAlarm(shard('ListNames#0'));
			jobState = (await rowOf('ListNames#0', jobId!))?.state;
		}
		expect(jobState).toBe('CANCELLED');
		let runState: string | null = null;
		for (let i = 0; i < 20 && runState !== 'CANCELLED'; i++) {
			await runDurableObjectAlarm(run as never);
			await new Promise((resolve) => setTimeout(resolve, 10));
			runState = await run.state();
		}
		expect(runState).toBe('CANCELLED');
	});

	it('確定したCANCELLEDは終端の通知(onSettled)の対象になる', async () => {
		const jobId = await queued('CX10#0');
		await shard('CX10#0').configure({ settled: { binding: 'CXNOTIFY', states: ['CANCELLED'] } });
		await shard('CX10#0').cancel(jobId);

		await setClock('CX10#0', T0 + GRACE);
		await runDurableObjectAlarm(shard('CX10#0'));

		const notice = await runInDurableObject(shard('CXNOTIFY#0'), (instance) => {
			const rows = (instance as any).repo.sql.exec(`SELECT payload FROM job`).toArray() as { payload: string }[];
			return rows.map((r) => JSON.parse(r.payload) as SettledNotice).find((n) => n.jobId === jobId) ?? null;
		});
		expect(notice?.state).toBe('CANCELLED');
	});
});
