import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { bearerAuth } from '../../src/api/auth.js';
import { Performer } from '../../src/core/api.js';
import { defineTsumugi } from '../../src/worker.js';
import { SORTABLE_COLUMNS, type RestEnv } from '../../src/api/rest.js';

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

describe('secretからのトークン解決', () => {
	const fromEnv = defineTsumugi<RestEnv>({
		performers: { REST: Noop },
		auth: bearerAuth((env: { TSUMUGI_TOKEN?: string }) => env.TSUMUGI_TOKEN),
	});

	const get = (envOverride: Record<string, unknown>, headers: Record<string, string> = {}) =>
		fromEnv.fetch!(
			new Request('https://example.com/api/jobs', { headers }),
			{ ...env, ...envOverride } as RestEnv,
			{
				waitUntil: () => {},
				passThroughOnException: () => {},
			} as unknown as ExecutionContext,
		);

	it('envのトークンと一致すれば通る', async () => {
		const res = await get({ TSUMUGI_TOKEN: 'from-secret' }, { authorization: 'Bearer from-secret' });
		expect(res.status).toBe(200);
	});

	it('一致しなければ401', async () => {
		const res = await get({ TSUMUGI_TOKEN: 'from-secret' }, { authorization: 'Bearer wrong' });
		expect(res.status).toBe(401);
	});

	it('secret未設定なら誰も通さない', async () => {
		// 解決できない場合に素通りさせると,設定漏れがそのまま公開になる
		const res = await get({ TSUMUGI_TOKEN: undefined }, { authorization: 'Bearer anything' });
		expect(res.status).toBe(401);
	});

	it('secret未設定でトークンも無ければ401', async () => {
		const res = await get({ TSUMUGI_TOKEN: undefined });
		expect(res.status).toBe(401);
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

describe('ジョブの投入', () => {
	const authorized = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

	const post = (body: unknown, headers: Record<string, string> = authorized) =>
		withAuth.fetch!(
			new Request('https://example.com/api/jobs', { method: 'POST', headers, body: JSON.stringify(body) }),
			env as RestEnv,
			{
				waitUntil: () => {},
				passThroughOnException: () => {},
			} as unknown as ExecutionContext,
		);

	it('投入するとジョブIDが返る', async () => {
		const res = await post({ binding: 'REST', payload: { n: 1 } });
		expect(res.status).toBe(201);
		const { id } = await res.json<{ id: string }>();
		expect(id).toMatch(/^REST#0:/);
	});

	it('未登録のbindingは400', async () => {
		const res = await post({ binding: 'NOPE', payload: {} });
		expect(res.status).toBe(400);
	});

	it('壊れたJSONは400', async () => {
		const res = await withAuth.fetch!(
			new Request('https://example.com/api/jobs', { method: 'POST', headers: authorized, body: '{' }),
			env as RestEnv,
			{ waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
		);
		expect(res.status).toBe(400);
	});

	it('認証が無ければ401', async () => {
		const res = await post({ binding: 'REST', payload: {} }, { 'content-type': 'application/json' });
		expect(res.status).toBe(401);
	});

	it('登録済みbindingが選択肢として返る', async () => {
		const res = await call(withAuth, 'GET', '/api/bindings', { authorization: `Bearer ${TOKEN}` });
		const { bindings } = await res.json<{ bindings: string[] }>();
		expect(bindings).toContain('REST');
	});
});

describe('保持期間を過ぎたジョブの操作(ADR-0027)', () => {
	// 一覧はD1から引くのでDOから消えても行は残る, 押す前と押した後の両方で分かる必要がある
	const shortLived = defineTsumugi<RestEnv>({
		performers: { GONE: Noop },
		auth: bearerAuth(TOKEN),
		bindings: { GONE: { failedRetentionMs: 1 } },
	});
	const authorized = { authorization: `Bearer ${TOKEN}` };

	/** DOには行が無くD1にだけ残っている状態を作る */
	async function orphan(id: string, state: string, updatedAt: number) {
		await env.TSUMUGI_DB.prepare(
			`INSERT OR REPLACE INTO job (id, seq, binding, state, priority, attempts, max_attempts, guarantee, created_at, updated_at, payload)
			 VALUES (?, 1, 'GONE', ?, 0, 3, 3, 'at-least-once', ?, ?, '{}')`,
		)
			.bind(id, state, updatedAt, updatedAt)
			.run();
	}

	const post = (handler: typeof withAuth, path: string) =>
		handler.fetch!(
			new Request(`https://example.com${path}`, { method: 'POST', headers: authorized }),
			env as RestEnv,
			{
				waitUntil: () => {},
				passThroughOnException: () => {},
			} as unknown as ExecutionContext,
		);

	it('DOから消えたジョブのretryは410', async () => {
		await orphan('GONE#0:swept', 'FAILED', T0 - 10 * 60 * 1000);
		const res = await post(shortLived, '/api/jobs/GONE%230%3Aswept/retry');

		// 状態違いの409と混ぜると,保持期間を延ばせば直るのかどうかが利用者に伝わらない
		expect(res.status).toBe(410);
		expect((await res.json<{ error: string }>()).error).toContain('retention');
	});

	it('状態が違うだけなら409', async () => {
		const jobId = await seedJob();
		const res = await post(withAuth, `/api/jobs/${encodeURIComponent(jobId)}/cancel`);
		expect(res.status).toBe(409);
	});

	it('保持期間を過ぎた行はretryable=falseで返る', async () => {
		// retryableは実時刻で判定するのでT0(未来の固定値)は使えない
		await orphan('GONE#0:old', 'FAILED', Date.now() - 10 * 60 * 1000);
		const res = await shortLived.fetch!(
			new Request('https://example.com/api/jobs?binding=GONE&limit=50', { headers: authorized }),
			env as RestEnv,
			{ waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
		);
		const { jobs } = await res.json<{ jobs: { id: string; retryable: boolean }[] }>();
		expect(jobs.find((j) => j.id === 'GONE#0:old')?.retryable).toBe(false);
	});

	it('窓の内側の失敗ジョブはretryable=true', async () => {
		const generous = defineTsumugi<RestEnv>({
			performers: { GONE: Noop },
			auth: bearerAuth(TOKEN),
			bindings: { GONE: { failedRetentionMs: 7 * 24 * 60 * 60 * 1000 } },
		});
		await orphan('GONE#0:fresh', 'FAILED', Date.now());
		const res = await generous.fetch!(
			new Request('https://example.com/api/jobs?binding=GONE&limit=50', { headers: authorized }),
			env as RestEnv,
			{ waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
		);
		const { jobs } = await res.json<{ jobs: { id: string; retryable: boolean }[] }>();
		expect(jobs.find((j) => j.id === 'GONE#0:fresh')?.retryable).toBe(true);
	});

	it('終端でない状態はretryable=false', async () => {
		await orphan('GONE#0:running', 'RUNNING', Date.now());
		const res = await shortLived.fetch!(
			new Request('https://example.com/api/jobs?binding=GONE&limit=50', { headers: authorized }),
			env as RestEnv,
			{ waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
		);
		const { jobs } = await res.json<{ jobs: { id: string; retryable: boolean }[] }>();
		expect(jobs.find((j) => j.id === 'GONE#0:running')?.retryable).toBe(false);
	});
});

describe('一覧の並べ替え', () => {
	const list = (query: string) => call(withAuth, 'GET', `/api/jobs?${query}`, { authorization: `Bearer ${TOKEN}` });

	/** 時刻をずらした投入,全て同時刻だと並び順の検証が素通りする */
	async function seedAt(now: number): Promise<void> {
		await runInDurableObject(shard('SORT#0'), (instance) => {
			(instance as any).clock = { now: () => now };
			(instance as any).env.TSUMUGI_QUEUE = { send: async () => {}, sendBatch: async () => {} };
		});
		await shard('SORT#0').enqueue({ binding: 'SORT', payload: {} });
		await runDurableObjectAlarm(shard('SORT#0'));
	}

	it('許可した全ての列でSQLが通る', async () => {
		// 許可リストの判定は単体で見ているが,列がスキーマに実在するかはここでしか分からない
		for (const column of SORTABLE_COLUMNS) {
			for (const order of ['asc', 'desc']) {
				const res = await list(`sort=${column}&order=${order}`);
				expect([column, order, res.status]).toEqual([column, order, 200]);
			}
		}
	});

	it('不正な列でも500にせず既定で返す', async () => {
		const res = await list('sort=payload; DROP TABLE job');
		expect(res.status).toBe(200);
	});

	it('向きの指定が結果に効く', async () => {
		for (const offset of [0, 60_000, 120_000]) await seedAt(T0 + offset);

		const times = async (order: string) => {
			const body = await (await list(`binding=SORT&sort=created_at&order=${order}`)).json<{ jobs: { created_at: number }[] }>();
			return body.jobs.map((j) => j.created_at);
		};

		const asc = await times('asc');
		const desc = await times('desc');

		expect(new Set(asc).size).toBeGreaterThan(1);
		expect(asc).toEqual([...asc].sort((a, b) => a - b));
		expect(desc).toEqual([...asc].reverse());
	});
});
