import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { bearerAuth } from '../../src/api/auth.js';
import { Performer } from '../../src/core/api.js';
import { defineTsumugi } from '../../src/worker.js';
import type { RestEnv } from '../../src/api/rest.js';

const T0 = 2_200_000_000_000;
const TOKEN = 'secret-token';

class Noop extends Performer<unknown, void, {}, RestEnv> {
	async perform(): Promise<void> {}
}

const withAuth = defineTsumugi<RestEnv>({ performers: { REST: Noop }, auth: bearerAuth(TOKEN) });
const withoutAuth = defineTsumugi<RestEnv>({ performers: { REST: Noop } });

/** 認証未設定で塞がっていることを機械的に保証するため,ルートを列挙して総当たりする */
const ROUTES: [method: string, path: string][] = [
	['GET', '/api/jobs'],
	['GET', '/api/stats'],
	['GET', '/api/jobs/REST%230:abc'],
	['POST', '/api/jobs/REST%230:abc/retry'],
	['POST', '/api/jobs/REST%230:abc/cancel'],
	['GET', '/'],
	['GET', '/api/unknown'],
];

const call = (handler: typeof withAuth, method: string, path: string, headers: Record<string, string> = {}) =>
	handler.fetch!(
		new Request(`https://example.com${path}`, { method, headers }),
		env as RestEnv,
		{
			waitUntil: () => {},
			passThroughOnException: () => {},
		} as unknown as ExecutionContext,
	);

const shard = (name: string) => env.JOB_SHARD.get(env.JOB_SHARD.idFromName(name));

async function seedJob(): Promise<string> {
	await runInDurableObject(shard('REST#0'), (instance) => {
		(instance as any).clock = { now: () => T0 };
		(instance as any).env.TSUMUGI_QUEUE = { send: async () => {}, sendBatch: async () => {} };
	});
	const jobId = await shard('REST#0').enqueue({ binding: 'REST', payload: { n: 1 } });
	await runDurableObjectAlarm(shard('REST#0'));
	return jobId;
}

describe('fail-closed認証(ADR-0013)', () => {
	it('認証未設定なら全ルートが404を返す', async () => {
		// 401でも403でもなく404,存在自体を明かさない
		for (const [method, path] of ROUTES) {
			const res = await call(withoutAuth, method, path);
			expect([method, path, res.status]).toEqual([method, path, 404]);
		}
	});

	it('トークンが無ければ401', async () => {
		const res = await call(withAuth, 'GET', '/api/jobs');
		expect(res.status).toBe(401);
	});

	it('トークンが違えば401', async () => {
		const res = await call(withAuth, 'GET', '/api/jobs', { authorization: `Bearer ${TOKEN}x` });
		expect(res.status).toBe(401);
	});

	it('スキームが違えば401', async () => {
		const res = await call(withAuth, 'GET', '/api/jobs', { authorization: `Basic ${TOKEN}` });
		expect(res.status).toBe(401);
	});

	it('正しいトークンなら通る', async () => {
		const res = await call(withAuth, 'GET', '/api/jobs', { authorization: `Bearer ${TOKEN}` });
		expect(res.status).toBe(200);
	});

	it('空のトークンは設定時点で拒否する', () => {
		expect(() => bearerAuth('')).toThrow();
	});
});

describe('REST API', () => {
	const authorized = { authorization: `Bearer ${TOKEN}` };

	it('一覧と詳細がD1の読み取りモデルから引ける', async () => {
		const jobId = await seedJob();

		const list = await call(withAuth, 'GET', '/api/jobs', authorized);
		const { jobs } = await list.json<{ jobs: { id: string }[] }>();
		expect(jobs.some((job) => job.id === jobId)).toBe(true);

		const detail = await call(withAuth, 'GET', `/api/jobs/${encodeURIComponent(jobId)}`, authorized);
		expect(detail.status).toBe(200);
	});

	it('存在しないジョブは404', async () => {
		const res = await call(withAuth, 'GET', '/api/jobs/REST%230:missing', authorized);
		expect(res.status).toBe(404);
	});

	it('状態別の集計が引ける', async () => {
		await seedJob();
		const res = await call(withAuth, 'GET', '/api/stats', authorized);
		const { byState } = await res.json<{ byState: Record<string, number> }>();
		expect(Object.values(byState).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
	});

	it('取り消せない状態のcancelは409を返す', async () => {
		const jobId = await seedJob();
		// QUEUED以降は実行済みかもしれないので取り消せない
		const res = await call(withAuth, 'POST', `/api/jobs/${encodeURIComponent(jobId)}/cancel`, authorized);
		expect(res.status).toBe(409);
	});

	it('不正な形式のジョブIDは400', async () => {
		const res = await call(withAuth, 'POST', '/api/jobs/not-a-job-id/retry', authorized);
		expect(res.status).toBe(400);
	});
});
