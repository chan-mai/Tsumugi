import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { TsumugiJobShard } from '../../src/do/job-shard.js';

const T0 = 2_400_000_000_000;

const shard = (name: string) => env.JOB_SHARD.get(env.JOB_SHARD.idFromName(name));

async function queued(name: string): Promise<string> {
	const stub = shard(name);
	await runInDurableObject(stub, (instance) => {
		(instance as any).clock = { now: () => T0 };
		(instance as any).env.TSUMUGI_QUEUE = { send: async () => {}, sendBatch: async () => {} };
	});
	const jobId = await stub.enqueue({ binding: name.split('#')[0] as string, payload: {}, timeoutMs: 60_000 });
	await runDurableObjectAlarm(stub);
	return jobId;
}

const rowOf = (stub: DurableObjectStub<TsumugiJobShard>, jobId: string) =>
	runInDurableObject(stub, (instance) => (instance as any).repo.find(jobId));

describe('生存報告(#35)', () => {
	it('実行中のジョブの報告時刻と進捗を記録する', async () => {
		const stub = shard('HBA#0');
		const jobId = await queued('HBA#0');

		await runInDurableObject(stub, (instance) => {
			(instance as any).clock = { now: () => T0 + 30_000 };
		});
		expect(await stub.heartbeat(jobId, 0.4)).toEqual({ accepted: true, cancelRequested: false });

		const row = await rowOf(stub, jobId);
		expect(row.heartbeat_at).toBe(T0 + 30_000);
		expect(row.progress).toBeCloseTo(0.4);
	});

	it('報告ごとに即時のtickを起動せず投影のalarmを数秒後に設定する', async () => {
		const stub = shard('HBG#0');
		const jobId = await queued('HBG#0');
		await runInDurableObject(stub, async (instance) => {
			(instance as any).clock = { now: () => T0 + 30_000 };
			await (instance as any).ctx.storage.deleteAlarm();
		});
		await stub.heartbeat(jobId, 0.5);
		const alarm = await runInDurableObject(stub, (instance) => (instance as any).ctx.storage.getAlarm());
		expect(alarm).toBe(T0 + 33_000);
	});

	it('範囲外の進捗を0以上1以下へ丸める', async () => {
		const stub = shard('HBB#0');
		const jobId = await queued('HBB#0');

		await stub.heartbeat(jobId, 5);
		expect((await rowOf(stub, jobId)).progress).toBe(1);

		await stub.heartbeat(jobId, -1);
		expect((await rowOf(stub, jobId)).progress).toBe(0);
	});

	it('報告のあいだreaperが回収しない', async () => {
		// timeoutMs 60秒でも報告継続中は無応答判定なし
		const stub = shard('HBC#0');
		const jobId = await queued('HBC#0');

		for (const at of [T0 + 60_000, T0 + 120_000, T0 + 180_000]) {
			await runInDurableObject(stub, (instance) => {
				(instance as any).clock = { now: () => at };
			});
			await stub.heartbeat(jobId);
			await runDurableObjectAlarm(stub);
		}
		expect((await rowOf(stub, jobId)).state).toBe('QUEUED');

		// 報告停止後はtimeoutMs + reaperGraceMsでreaper処理
		await runInDurableObject(stub, (instance) => {
			(instance as any).clock = { now: () => T0 + 180_000 + 90_000 };
		});
		await runDurableObjectAlarm(stub);
		expect((await rowOf(stub, jobId)).state).toBe('SCHEDULED');
	});

	it('終端に達したジョブの報告は当たらない', async () => {
		const stub = shard('HBD#0');
		const jobId = await queued('HBD#0');
		await stub.report(jobId, { ok: true });

		expect(await stub.heartbeat(jobId, 0.5)).toEqual({ accepted: false, cancelRequested: false });
		expect((await rowOf(stub, jobId)).progress).toBeNull();
	});

	it('遷移で前の試行の報告を消去する', async () => {
		// 残存時は前試行の報告で再実行後のreaper期限が延長
		const stub = shard('HBE#0');
		const jobId = await queued('HBE#0');
		await stub.heartbeat(jobId, 0.7);

		await stub.report(jobId, { ok: false, error: 'intentional failure' });

		const row = await rowOf(stub, jobId);
		expect(row.heartbeat_at).toBeNull();
		expect(row.progress).toBeNull();
	});

	it('実行中の進捗が読み取りモデルへ投影される', async () => {
		// 画面での進行中/停止の判別用
		const stub = shard('HBF#0');
		const jobId = await queued('HBF#0');
		await stub.heartbeat(jobId, 0.25);
		await runDurableObjectAlarm(stub);

		const { results } = await env.TSUMUGI_DB.prepare(`SELECT progress, state FROM job WHERE id = ?`)
			.bind(jobId)
			.all<{ progress: number; state: string }>();
		expect(results[0]?.state).toBe('QUEUED');
		expect(results[0]?.progress).toBeCloseTo(0.25);
	});
});
