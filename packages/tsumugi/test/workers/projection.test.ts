import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { project, type OutboxRow } from '../../src/projection/projector.js';

const T0 = 2_100_000_000_000;

const noopQueue = {
	send: async () => {},
	sendBatch: async () => {},
};

const shard = (name: string) => env.JOB_SHARD.get(env.JOB_SHARD.idFromName(name));

async function install(name: string, now: number, db?: unknown) {
	await runInDurableObject(shard(name), (instance) => {
		(instance as any).clock = { now: () => now };
		(instance as any).env.TSUMUGI_QUEUE = noopQueue;
		if (db !== undefined) (instance as any).env.TSUMUGI_DB = db;
	});
}

const outboxCount = (name: string) => runInDurableObject(shard(name), (instance) => (instance as any).repo.countOutbox() as number);

const readD1 = async (jobId: string) =>
	env.TSUMUGI_DB.prepare('SELECT id, seq, state, attempts FROM job WHERE id = ?').bind(jobId).first<{
		id: string;
		seq: number;
		state: string;
		attempts: number;
	}>();

describe('D1への投影(ADR-0008)', () => {
	it('tickでジョブがD1に現れる', async () => {
		await install('PROJ#0', T0);
		const jobId = await shard('PROJ#0').enqueue({ binding: 'PROJ', payload: { n: 1 } });

		await runDurableObjectAlarm(shard('PROJ#0'));

		const row = await readD1(jobId);
		expect(row).toMatchObject({ id: jobId, state: 'QUEUED' });
		// 投影が済んだアウトボックスは消える
		expect(await outboxCount('PROJ#0')).toBe(0);
	});

	it('同じ範囲を2回流しても結果が変わらない', async () => {
		await install('PROJ2#0', T0);
		const jobId = await shard('PROJ2#0').enqueue({ binding: 'PROJ2', payload: {} });
		await runDurableObjectAlarm(shard('PROJ2#0'));
		const first = await readD1(jobId);

		// アウトボックスが二重に読まれた状況を再現する
		const rows: OutboxRow[] = [{ seq: first!.seq, job_id: jobId, snapshot: JSON.stringify({ ...(await snapshotOf('PROJ2#0', jobId)) }) }];
		await project(env.TSUMUGI_DB, rows);
		await project(env.TSUMUGI_DB, rows);

		expect(await readD1(jobId)).toEqual(first);
	});

	it('古いseqの投影は新しい状態を上書きしない', async () => {
		await install('PROJ3#0', T0);
		const jobId = await shard('PROJ3#0').enqueue({ binding: 'PROJ3', payload: {} });
		await runDurableObjectAlarm(shard('PROJ3#0'));
		const current = await readD1(jobId);

		// 順序が入れ替わって古い状態が遅れて届いた状況
		const stale = await snapshotOf('PROJ3#0', jobId);
		await project(env.TSUMUGI_DB, [{ seq: 1, job_id: jobId, snapshot: JSON.stringify({ ...stale, state: 'SCHEDULED' }) }]);

		const after = await readD1(jobId);
		expect(after!.state).toBe(current!.state);
		expect(after!.seq).toBe(current!.seq);
	});

	it('D1への書き込みが失敗したらカーソルを進めない', async () => {
		const brokenDb = {
			prepare: () => ({ bind: () => ({}) }),
			batch: async () => {
				throw new Error('D1が落ちている');
			},
		};
		await install('PROJ4#0', T0, brokenDb);
		await shard('PROJ4#0').enqueue({ binding: 'PROJ4', payload: {} });

		const before = await outboxCount('PROJ4#0');
		expect(before).toBeGreaterThan(0);
		await runDurableObjectAlarm(shard('PROJ4#0'));

		// 投影に失敗してもアウトボックスは残り,次のtickで追いつく
		expect(await outboxCount('PROJ4#0')).toBeGreaterThanOrEqual(before);
		// tickが停止しないよう次のalarmが張り直されている
		const alarm = await runInDurableObject(shard('PROJ4#0'), (_i, state) => state.storage.getAlarm());
		expect(alarm).not.toBeNull();
	});
});

async function snapshotOf(name: string, jobId: string) {
	return runInDurableObject(shard(name), (instance) => (instance as any).repo.find(jobId) as Record<string, unknown>);
}
