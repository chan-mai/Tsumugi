import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
// 公開エントリ経由で読む, 再エクスポートが壊れた場合も検出する
import { bearerAuth, createFlow, unsafeNoAuth } from '../../src/entries/index.js';
import { Performer } from '../../src/performer/entrypoint.js';
import { defineTsumugi } from '../../src/worker.js';
import { createRest, SORTABLE_COLUMNS, type RestEnv } from '../../src/api/rest.js';
import { ERROR_MAX_CHARS } from '../../src/do/repo.js';

const T0 = 2_200_000_000_000;
const TOKEN = 'secret-token';

class Noop extends Performer<unknown, void, {}, RestEnv> {
	async perform(): Promise<void> {}
}

const withAuth = defineTsumugi({ performers: { REST: Noop }, auth: bearerAuth(TOKEN) });
const withoutAuth = defineTsumugi({ performers: { REST: Noop } });

/** 認証未設定で塞がっていることを機械的に保証するため,ルートを列挙して総当たりする */
const ROUTES: [method: string, path: string][] = [
	['GET', '/api/jobs'],
	['GET', '/api/stats'],
	['GET', '/api/jobs/REST%230:abc'],
	['POST', '/api/jobs/REST%230:abc/retry'],
	['POST', '/api/jobs/REST%230:abc/cancel'],
	['POST', '/api/jobs/REST%230:abc/reschedule'],
	['POST', '/api/jobs/bulk-retry'],
	['POST', '/api/jobs/bulk-cancel'],
	['GET', '/api/metrics'],
	['GET', '/api/schedules'],
	['POST', '/api/bindings/REST/policy'],
	['POST', '/api/bindings/REST/policy/reset'],
	['GET', '/'],
	['GET', '/api/unknown'],
];

const call = (handler: ExportedHandler<RestEnv>, method: string, path: string, headers: Record<string, string> = {}) =>
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

describe('明示的な無認証(ADR-0044)', () => {
	it('資格情報なしでAPIに到達できる', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const open = defineTsumugi({ performers: { REST: Noop }, auth: unsafeNoAuth() });
			for (const path of ['/api/jobs', '/api/bindings']) {
				const res = await call(open, 'GET', path);
				expect([path, res.status]).toEqual([path, 200]);
			}
		} finally {
			warn.mockRestore();
		}
	});

	it('警告はisolateごとに1回だけ出す', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const open = defineTsumugi({ performers: { REST: Noop }, auth: unsafeNoAuth() });
			await call(open, 'GET', '/api/jobs');
			await call(open, 'GET', '/api/jobs');
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});

	it('渡さなければ従来どおり塞がる', async () => {
		const res = await call(withoutAuth, 'GET', '/api/jobs');
		expect(res.status).toBe(404);
	});
});

describe('secretからのトークン解決', () => {
	const fromEnv = defineTsumugi({
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

	it('詳細が返す列を固定する', async () => {
		// 展開すると投影の内部列(seq)やcamelCaseの重複まで公開される
		const jobId = await seedJob();
		const res = await call(withAuth, 'GET', `/api/jobs/${encodeURIComponent(jobId)}`, authorized);
		const { job } = await res.json<{ job: Record<string, unknown> }>();

		expect(Object.keys(job).sort()).toEqual([
			'attempts',
			'attempts_log',
			'binding',
			'concurrency_key',
			'created_at',
			'dispatched_at',
			'guarantee',
			'id',
			'max_attempts',
			'node_id',
			'payload',
			'priority',
			'progress',
			'result',
			'retryable',
			'run_after',
			'run_id',
			'state',
			'unique_key',
			'updated_at',
		]);
	});

	it('runから投入したジョブは詳細で宛先を返す(ADR-0015)', async () => {
		// 画面はここからrunの詳細へ辿る, 単発で投入したジョブはnullのまま
		const runId = 'REST:link';
		await env.TSUMUGI_DB.prepare(
			`INSERT INTO job (id, binding, state, priority, attempts, max_attempts, guarantee, payload, created_at, updated_at, seq, run_id, node_id)
			 VALUES (?, 'REST', 'COMPLETED', 0, 1, 3, 'at-least-once', '{}', 1, 1, 9001, ?, 'list')`,
		)
			.bind('REST#0:linked', runId)
			.run();

		const res = await call(withAuth, 'GET', `/api/jobs/${encodeURIComponent('REST#0:linked')}`, authorized);
		const { job } = await res.json<{ job: { run_id: string | null; node_id: string | null } }>();
		expect(job.run_id).toBe(runId);
		expect(job.node_id).toBe('list');

		const single = await call(withAuth, 'GET', `/api/jobs/${encodeURIComponent(await seedJob())}`, authorized);
		const { job: plain } = await single.json<{ job: { run_id: string | null; node_id: string | null } }>();
		expect(plain.run_id).toBeNull();
		expect(plain.node_id).toBeNull();
	});

	it('流量を実行時に変えられる(#27)', async () => {
		await seedJob();
		const post = (body: unknown, path = '/api/bindings/REST/policy') =>
			withAuth.fetch!(
				new Request(`https://example.com${path}`, {
					method: 'POST',
					headers: { ...authorized, 'content-type': 'application/json' },
					body: JSON.stringify(body),
				}),
				env as RestEnv,
				{ waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
			);

		const res = await post({ paused: true, concurrency: 5, perKeyRate: { tokens: 3, intervalMs: 1_000 } });
		expect(res.status).toBe(200);
		const body = await res.json<{ binding: string; shards: number; policy: { paused: boolean; concurrency: number } }>();
		expect(body).toMatchObject({
			binding: 'REST',
			shards: 1,
			policy: { paused: true, concurrency: 5, perKeyRate: { tokens: 3, intervalMs: 1_000 } },
		});

		// 渡さなかった項目は変わらない
		const next = await (await post({ paused: false })).json<{ policy: { paused: boolean; concurrency: number } }>();
		expect(next.policy).toMatchObject({ paused: false, concurrency: 5 });

		// 診断が今効いている値を返す
		const diag = await call(withAuth, 'GET', '/api/diagnostics', authorized);
		const seen = await diag.json<{
			bindings: Record<string, { policy: { concurrency: number }; blocked: { paused: boolean; perKeyTokens: boolean } }>;
		}>();
		expect(seen.bindings.REST?.policy.concurrency).toBe(5);
		expect(typeof seen.bindings.REST?.blocked.paused).toBe('boolean');
		expect(typeof seen.bindings.REST?.blocked.perKeyTokens).toBe('boolean');

		// 実行時の設定を捨てると既定へ戻る
		expect((await post({}, '/api/bindings/REST/policy/reset')).status).toBe(200);
		const reset = await call(withAuth, 'GET', '/api/diagnostics', authorized);
		const after = await reset.json<{ bindings: Record<string, { policy: { concurrency: number } }> }>();
		expect(after.bindings.REST?.policy.concurrency).toBe(100);
	});

	it('流量の指定を検証する(#27)', async () => {
		const post = (body: unknown, binding = 'REST') =>
			withAuth.fetch!(
				new Request(`https://example.com/api/bindings/${binding}/policy`, {
					method: 'POST',
					headers: { ...authorized, 'content-type': 'application/json' },
					body: JSON.stringify(body),
				}),
				env as RestEnv,
				{ waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
			);

		expect((await post({ concurrency: -1 })).status).toBe(400);
		expect((await post({ paused: 'yes' })).status).toBe(400);
		expect((await post({ rate: { tokens: 1, intervalMs: 0 } })).status).toBe(400);
		expect((await post({ perKeyRate: { tokens: -1, intervalMs: 1_000 } })).status).toBe(400);
		expect((await post({ perKeyRate: { tokens: 1, intervalMs: 0 } })).status).toBe(400);
		expect((await post({ perKeyRate: 5 })).status).toBe(400);
		expect((await post({ agingIntervalMs: 0 })).status).toBe(400);
		// 変更する項目が無い要求は取り違えの元
		expect((await post({})).status).toBe(400);
		// 未登録のbindingは404
		expect((await post({ paused: true }, 'NOPE')).status).toBe(404);
		// 0は投入を止める指定として通す
		expect((await post({ concurrency: 0 })).status).toBe(200);
		expect((await post({ rate: null, agingIntervalMs: null })).status).toBe(200);
		expect((await post({ perKeyRate: null })).status).toBe(200);

		// 変更はshardに残るので, 後続のテストのために捨てておく
		await withAuth.fetch!(
			new Request('https://example.com/api/bindings/REST/policy/reset', { method: 'POST', headers: authorized }),
			env as RestEnv,
			{ waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
		);
	});

	it('一部のshardへ届かなければ500と対象を返す(#27)', async () => {
		// 分割している構成で片方だけ落ちる状況, 成功として返すと止まっていない投入を止まったものとして扱う
		const sharded = defineTsumugi({
			performers: { REST: Noop },
			auth: bearerAuth(TOKEN),
			bindings: { REST: { shards: 2 } },
		});
		// shard 1だけが失敗するJOB_SHARDへ差し替える
		const broken = {
			...env,
			JOB_SHARD: {
				idFromName: (name: string) => ({ name }),
				get: (id: { name: string }) => ({
					updatePolicy: async () => {
						if (id.name.endsWith('#1')) throw new Error('unreachable');
						return { paused: true };
					},
					resetPolicy: async () => {
						if (id.name.endsWith('#1')) throw new Error('unreachable');
					},
				}),
			},
		} as unknown as RestEnv;

		const call = (path: string) =>
			sharded.fetch!(
				new Request(`https://example.com${path}`, {
					method: 'POST',
					headers: { ...authorized, 'content-type': 'application/json' },
					body: JSON.stringify({ paused: true }),
				}),
				broken,
				{ waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
			);

		const res = await call('/api/bindings/REST/policy');
		expect(res.status).toBe(500);
		const body = await res.json<{ binding: string; shards: number; failed: number[] }>();
		expect(body).toMatchObject({ binding: 'REST', shards: 2, failed: [1] });

		// resetも同じ扱い, 片方だけ静的設定へ戻ると設定が食い違う
		expect((await call('/api/bindings/REST/policy/reset')).status).toBe(500);
	});

	it('statsが最古のSCHEDULEDの経過時間を返す(#10)', async () => {
		await seedJob();
		const res = await call(withAuth, 'GET', '/api/stats', authorized);
		expect(res.status).toBe(200);
		const body = await res.json<{ byState: Record<string, number>; oldestScheduledMs: number | null }>();
		// SCHEDULEDが無ければnull, あれば経過時間の数値
		expect('oldestScheduledMs' in body).toBe(true);
	});

	it('診断がバックログと投入制約をDOから返す(#10)', async () => {
		await seedJob();
		const res = await call(withAuth, 'GET', '/api/diagnostics', authorized);
		expect(res.status).toBe(200);

		const body = await res.json<{
			shard: number;
			bindings: Record<string, { active: number; outbox: number; blocked: { capacity: boolean } }>;
		}>();
		expect(body.shard).toBe(0);
		// 登録済みbindingのshard 0の稼働中件数が引ける
		expect(typeof body.bindings.REST?.active).toBe('number');
		expect(typeof body.bindings.REST?.blocked?.capacity).toBe('boolean');
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
	const shortLived = defineTsumugi({
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

	const post = (handler: ExportedHandler<RestEnv>, path: string) =>
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

	it('保持期間内の失敗ジョブはretryable=true', async () => {
		const generous = defineTsumugi({
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

describe('試行履歴(ADR-0028)', () => {
	const authorized = { authorization: `Bearer ${TOKEN}` };
	const q = { send: async () => {}, sendBatch: async () => {} };

	async function runFailing(name: string, binding: string, maxAttempts: number) {
		await runInDurableObject(shard(name), (instance) => {
			(instance as any).clock = { now: () => T0 };
			(instance as any).env.TSUMUGI_QUEUE = q;
		});
		const jobId = await shard(name).enqueue({ binding, payload: {}, maxAttempts });
		await runDurableObjectAlarm(shard(name));
		await shard(name).report(jobId, { ok: false, error: 'Error: boom\nat somewhere' });
		// 報告はアウトボックスに積むだけ, もう1回流さないとD1に届かない
		await runDurableObjectAlarm(shard(name));
		return jobId;
	}

	const detail = async (jobId: string) => {
		const res = await call(withAuth, 'GET', `/api/jobs/${encodeURIComponent(jobId)}`, authorized);
		return res.json<{ job: { attempts: number; attempts_log: { attempt: number; state: string; error: string | null }[] } }>();
	};

	it('失敗の理由が残る', async () => {
		const jobId = await runFailing('LOG#0', 'LOG', 1);
		const { job } = await detail(jobId);

		expect(job.attempts_log).toHaveLength(1);
		expect(job.attempts_log[0]).toMatchObject({ attempt: 1, state: 'FAILED' });
		expect(job.attempts_log[0]?.error).toContain('boom');
	});

	it('試行回数の数値を上書きしない', async () => {
		// 履歴を`attempts`という名前で返すと画面の n/m が壊れる
		const jobId = await runFailing('LOG2#0', 'LOG2', 1);
		const { job } = await detail(jobId);
		expect(typeof job.attempts).toBe('number');
		expect(job.attempts).toBe(1);
	});

	it('1回目で成功したジョブは履歴を持たない', async () => {
		// ジョブ行から導出できる情報を書くと1ジョブあたりの書き込みが1回増える
		await runInDurableObject(shard('LOG3#0'), (instance) => {
			(instance as any).clock = { now: () => T0 };
			(instance as any).env.TSUMUGI_QUEUE = q;
		});
		const jobId = await shard('LOG3#0').enqueue({ binding: 'LOG3', payload: {} });
		await runDurableObjectAlarm(shard('LOG3#0'));
		await shard('LOG3#0').report(jobId, { ok: true });
		await runDurableObjectAlarm(shard('LOG3#0'));

		const { job } = await detail(jobId);
		// 保存はしないが表示はする, ジョブ行から組み立てて返す
		expect(job.attempts_log).toHaveLength(1);
		expect(job.attempts_log[0]).toMatchObject({ attempt: 1, state: 'COMPLETED', error: null });
		expect(job.attempts).toBe(1);
	});

	it('失敗の後に成功すれば両方残る', async () => {
		// 失敗だけ残すと,なぜ今COMPLETEDなのかが履歴から読めなくなる
		await runInDurableObject(shard('LOG6#0'), (instance) => {
			(instance as any).clock = { now: () => T0 };
			(instance as any).env.TSUMUGI_QUEUE = q;
		});
		const jobId = await shard('LOG6#0').enqueue({ binding: 'LOG6', payload: {}, maxAttempts: 3 });
		await runDurableObjectAlarm(shard('LOG6#0'));
		await shard('LOG6#0').report(jobId, { ok: false, error: 'first failure' });

		// リトライ待ちを越えて再投入させる
		await runInDurableObject(shard('LOG6#0'), (instance) => {
			(instance as any).clock = { now: () => T0 + 10 * 60 * 1000 };
		});
		await runDurableObjectAlarm(shard('LOG6#0'));
		await shard('LOG6#0').report(jobId, { ok: true });
		await runDurableObjectAlarm(shard('LOG6#0'));

		const { job } = await detail(jobId);
		expect(job.attempts_log.map((a) => [a.attempt, a.state])).toEqual([
			[2, 'COMPLETED'],
			[1, 'FAILED'],
		]);
	});

	it('エラー本文を打ち切る', async () => {
		// performerの例外はHTMLページ丸ごとのこともある, 無制限だとDOとD1を圧迫する
		await runInDurableObject(shard('LOG4#0'), (instance) => {
			(instance as any).clock = { now: () => T0 };
			(instance as any).env.TSUMUGI_QUEUE = q;
		});
		const jobId = await shard('LOG4#0').enqueue({ binding: 'LOG4', payload: {}, maxAttempts: 1 });
		await runDurableObjectAlarm(shard('LOG4#0'));
		await shard('LOG4#0').report(jobId, { ok: false, error: 'x'.repeat(50_000) });
		await runDurableObjectAlarm(shard('LOG4#0'));

		const { job } = await detail(jobId);
		expect(job.attempts_log[0]?.error?.length).toBe(ERROR_MAX_CHARS);
	});

	it('一覧には履歴を載せない', async () => {
		// 1画面ぶんの履歴は数百KBになり得る
		const jobId = await runFailing('LOG5#0', 'LOG5', 1);
		const res = await call(withAuth, 'GET', '/api/jobs?binding=LOG5', authorized);
		const { jobs } = await res.json<{ jobs: Record<string, unknown>[] }>();
		const row = jobs.find((j) => j.id === jobId);
		expect(row).toBeDefined();
		expect(row).not.toHaveProperty('attempts_log');
	});
});

describe('メトリクスの参照', () => {
	const authorized = { authorization: `Bearer ${TOKEN}` };

	it('未設定なら501', async () => {
		// Analytics Engineの読み取りにはアカウントのAPIトークンが要る
		const res = await call(withAuth, 'GET', '/api/metrics', authorized);
		expect(res.status).toBe(501);
	});

	it('設定があれば集計を返す', async () => {
		const configured = defineTsumugi({
			performers: { REST: Noop },
			auth: bearerAuth(TOKEN),
			metrics: () => ({ accountId: 'acct', apiToken: 'token', dataset: 'tsumugi_jobs' }),
		});
		// 上流の応答を差し替える, 実際のAnalytics Engineへは出さない
		const original = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ data: [{ binding: 'REST', total: '4', failed: '1' }] }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})) as unknown as typeof globalThis.fetch;

		try {
			const res = await call(configured, 'GET', '/api/metrics?hours=48', authorized);
			expect(res.status).toBe(200);
			const body = await res.json<{ hours: number; bindings: { binding: string; failureRate: number }[] }>();
			expect(body.hours).toBe(48);
			expect(body.bindings[0]).toMatchObject({ binding: 'REST', failureRate: 0.25 });
		} finally {
			globalThis.fetch = original;
		}
	});

	it('範囲外の区間は400', async () => {
		const configured = defineTsumugi({
			performers: { REST: Noop },
			auth: bearerAuth(TOKEN),
			metrics: () => ({ accountId: 'acct', apiToken: 'token', dataset: 'tsumugi_jobs' }),
		});
		const res = await call(configured, 'GET', '/api/metrics?hours=1000', authorized);
		expect(res.status).toBe(400);
	});

	it('上流が断ると502', async () => {
		// 設定の誤りと上流の不調を500で混ぜない
		const configured = defineTsumugi({
			performers: { REST: Noop },
			auth: bearerAuth(TOKEN),
			metrics: () => ({ accountId: 'acct', apiToken: 'token', dataset: 'tsumugi_jobs' }),
		});
		const original = globalThis.fetch;
		globalThis.fetch = (async () => new Response('unauthorized', { status: 403 })) as unknown as typeof globalThis.fetch;

		try {
			const res = await call(configured, 'GET', '/api/metrics', authorized);
			expect(res.status).toBe(502);
		} finally {
			globalThis.fetch = original;
		}
	});
});

describe('一覧の絞り込み', () => {
	const authorized = { authorization: `Bearer ${TOKEN}` };

	/** 読み取りモデルへ直接入れる, DOを経由せず条件だけを試す */
	async function seed(row: { id: string; uniqueKey?: string; concurrencyKey?: string; createdAt: number }) {
		await env.TSUMUGI_DB.prepare(
			`INSERT OR REPLACE INTO job (id, seq, binding, state, priority, attempts, max_attempts, unique_key, concurrency_key, guarantee, created_at, updated_at, payload)
			 VALUES (?, 1, 'FILTER', 'COMPLETED', 0, 1, 3, ?, ?, 'at-least-once', ?, ?, '{}')`,
		)
			.bind(row.id, row.uniqueKey ?? null, row.concurrencyKey ?? null, row.createdAt, row.createdAt)
			.run();
	}

	const idsOf = async (query: string) => {
		const res = await call(withAuth, 'GET', `/api/jobs?binding=FILTER&${query}`, authorized);
		const { jobs } = await res.json<{ jobs: { id: string }[] }>();
		return jobs.map((job) => job.id).sort();
	};

	it('ID, キー, 期間で絞り込める', async () => {
		await seed({ id: 'FILTER#0:one', uniqueKey: 'u-one', concurrencyKey: 'group-a', createdAt: 1_000 });
		await seed({ id: 'FILTER#0:two', uniqueKey: 'u-two', concurrencyKey: 'group-a', createdAt: 2_000 });
		await seed({ id: 'FILTER#0:three', uniqueKey: 'u-three', concurrencyKey: 'group-b', createdAt: 3_000 });

		expect(await idsOf('id=FILTER%230%3Aone')).toEqual(['FILTER#0:one']);
		expect(await idsOf('unique_key=u-two')).toEqual(['FILTER#0:two']);
		expect(await idsOf('concurrency_key=group-a')).toEqual(['FILTER#0:one', 'FILTER#0:two']);
		// 範囲は両端を含む
		expect(await idsOf('created_from=2000&created_to=3000')).toEqual(['FILTER#0:three', 'FILTER#0:two']);
	});

	it('条件を重ねると積になる', async () => {
		await seed({ id: 'FILTER#0:one', uniqueKey: 'u-one', concurrencyKey: 'group-a', createdAt: 1_000 });
		await seed({ id: 'FILTER#0:two', uniqueKey: 'u-two', concurrencyKey: 'group-a', createdAt: 2_000 });

		expect(await idsOf('concurrency_key=group-a&created_from=2000')).toEqual(['FILTER#0:two']);
	});

	it('一致しない条件は0件で総数も0', async () => {
		await seed({ id: 'FILTER#0:one', uniqueKey: 'u-one', createdAt: 1_000 });

		const res = await call(withAuth, 'GET', '/api/jobs?binding=FILTER&unique_key=missing', authorized);
		const { jobs, total } = await res.json<{ jobs: unknown[]; total: number }>();
		expect(jobs).toEqual([]);
		expect(total).toBe(0);
	});
});

describe('一括リトライと一括取り消し', () => {
	const authorized = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

	const post = (action: 'retry' | 'cancel', body: unknown) =>
		withAuth.fetch!(
			new Request(`https://example.com/api/jobs/bulk-${action}`, { method: 'POST', headers: authorized, body: JSON.stringify(body) }),
			env as RestEnv,
			{ waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
		);

	/** 実際にFAILEDのジョブを作る、DO側の状態判定まで通す */
	async function failedJob(): Promise<string> {
		const stub = shard('REST#0');
		await runInDurableObject(stub, (instance) => {
			(instance as any).clock = { now: () => T0 };
			(instance as any).env.TSUMUGI_QUEUE = { send: async () => {}, sendBatch: async () => {} };
		});
		const jobId = await stub.enqueue({ binding: 'REST', payload: {}, maxAttempts: 1 });
		await runDurableObjectAlarm(stub);
		await stub.report(jobId, { ok: false, error: 'intentional failure' });
		await runDurableObjectAlarm(stub);
		return jobId;
	}

	const stateOf = async (jobId: string) => {
		const res = await call(withAuth, 'GET', `/api/jobs/${encodeURIComponent(jobId)}`, { authorization: `Bearer ${TOKEN}` });
		const { job } = await res.json<{ job: { state: string } }>();
		return job.state;
	};

	const shardsFailing = (unreachable: readonly string[]) => ({
		idFromName: (name: string) => name,
		get: (name: string) => ({
			mutateMany: async (_action: string, ids: string[]) => {
				if (unreachable.includes(name)) throw new Error('shard is unreachable');
				return { ok: ids, failed: [] };
			},
		}),
	});

	const bulkWith = (shards: unknown, ids: string[]) =>
		createRest(bearerAuth(TOKEN), { bindings: ['REST'] }).request(
			'/api/jobs/bulk-retry',
			{ method: 'POST', headers: authorized, body: JSON.stringify({ ids }) },
			{ ...env, JOB_SHARD: shards } as unknown as RestEnv,
		);

	it('応答しないshardの対象をunreachableとして返す', async () => {
		// 1つのshardが応答しなくても200で返す, 500にすると成功した分まで再送される
		const res = await bulkWith(shardsFailing(['REST#0']), ['REST#0:a', 'REST#0:b']);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			ok: [],
			failed: [
				{ id: 'REST#0:a', reason: 'unreachable' },
				{ id: 'REST#0:b', reason: 'unreachable' },
			],
			remaining: 0,
		});
	});

	it('応答したshardの結果は残す', async () => {
		// 成功した分を結果に含めないと呼び出し側が再送し、同じ操作を二度実行する
		const res = await bulkWith(shardsFailing(['REST#1']), ['REST#0:a', 'REST#1:b']);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			ok: ['REST#0:a'],
			failed: [{ id: 'REST#1:b', reason: 'unreachable' }],
			remaining: 0,
		});
	});

	it('選択したIDをまとめてリトライする', async () => {
		const jobId = await failedJob();
		expect(await stateOf(jobId)).toBe('FAILED');

		const res = await post('retry', { ids: [jobId] });
		expect(res.status).toBe(200);
		const body = await res.json<{ ok: string[]; remaining: number }>();
		expect(body.ok).toEqual([jobId]);
		expect(body.remaining).toBe(0);

		await runDurableObjectAlarm(shard('REST#0'));
		expect(await stateOf(jobId)).not.toBe('FAILED');
	});

	it('条件に一致するジョブをまとめてリトライする', async () => {
		const jobId = await failedJob();
		expect(await stateOf(jobId)).toBe('FAILED');

		const res = await post('retry', { binding: 'REST' });
		expect(res.status).toBe(200);
		const body = await res.json<{ ok: string[]; failed: unknown[]; remaining: number }>();
		expect(body.ok).toContain(jobId);
		expect(body.remaining).toBe(0);

		await runDurableObjectAlarm(shard('REST#0'));
		expect(await stateOf(jobId)).not.toBe('FAILED');
	});

	it('上限を超えた分を残り件数として返す', async () => {
		await failedJob();
		await failedJob();

		const res = await post('retry', { binding: 'REST', limit: 1 });
		const body = await res.json<{ ok: string[]; remaining: number }>();
		expect(body.ok).toHaveLength(1);
		expect(body.remaining).toBeGreaterThanOrEqual(1);
	});

	it('DOに無いジョブは理由付きで断る', async () => {
		// 読み取りモデルにだけ残っている行、全体を失敗にはしない
		await env.TSUMUGI_DB.prepare(
			`INSERT OR REPLACE INTO job (id, seq, binding, state, priority, attempts, max_attempts, guarantee, created_at, updated_at, payload)
			 VALUES ('BULKGONE#0:x', 1, 'BULKGONE', 'FAILED', 0, 3, 3, 'at-least-once', 1, 1, '{}')`,
		).run();

		const res = await post('retry', { binding: 'BULKGONE' });
		expect(res.status).toBe(200);
		const body = await res.json<{ ok: string[]; failed: { id: string; reason: string }[] }>();
		expect(body.ok).toEqual([]);
		expect(body.failed).toEqual([{ id: 'BULKGONE#0:x', reason: 'gone' }]);
	});

	it('操作が受け付けない状態の指定は400', async () => {
		const res = await post('retry', { state: 'RUNNING' });
		expect(res.status).toBe(400);
	});

	it('壊れたJSONは400', async () => {
		const res = await withAuth.fetch!(
			new Request('https://example.com/api/jobs/bulk-retry', { method: 'POST', headers: authorized, body: '{' }),
			env as RestEnv,
			{ waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
		);
		expect(res.status).toBe(400);
	});
});

describe('予約済みジョブの実行時刻の変更', () => {
	const authorized = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

	const post = (path: string, body: unknown) =>
		withAuth.fetch!(
			new Request(`https://example.com${path}`, { method: 'POST', headers: authorized, body: JSON.stringify(body) }),
			env as RestEnv,
			{ waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
		);

	/** 先の時刻を予約したジョブ, tickを回してもSCHEDULEDのまま残る */
	async function scheduled(runAt: number): Promise<string> {
		await runInDurableObject(shard('REST#0'), (instance) => {
			(instance as any).clock = { now: () => T0 };
			(instance as any).env.TSUMUGI_QUEUE = { send: async () => {}, sendBatch: async () => {} };
		});
		const jobId = await shard('REST#0').enqueue({ binding: 'REST', payload: {}, runAt });
		await runDurableObjectAlarm(shard('REST#0'));
		return jobId;
	}

	const detailOf = async (jobId: string) => {
		const res = await call(withAuth, 'GET', `/api/jobs/${encodeURIComponent(jobId)}`, { authorization: `Bearer ${TOKEN}` });
		const { job } = await res.json<{ job: { state: string; run_after: number | null; priority: number } }>();
		return job;
	};

	it('予定時刻を動かすと読み取りモデルにも反映される', async () => {
		const jobId = await scheduled(T0 + 3_600_000);
		expect((await detailOf(jobId)).run_after).toBe(T0 + 3_600_000);

		const res = await post(`/api/jobs/${encodeURIComponent(jobId)}/reschedule`, { runAt: T0 + 60_000 });
		expect(res.status).toBe(200);
		await runDurableObjectAlarm(shard('REST#0'));

		const job = await detailOf(jobId);
		expect(job.run_after).toBe(T0 + 60_000);
		// 取り消して再投入する場合と異なり同じジョブIDのまま変更される
		expect(job.state).toBe('SCHEDULED');
	});

	it('priorityも同じ経路で変更できる', async () => {
		const jobId = await scheduled(T0 + 3_600_000);

		await post(`/api/jobs/${encodeURIComponent(jobId)}/reschedule`, { runAt: T0 + 120_000, priority: 7 });
		await runDurableObjectAlarm(shard('REST#0'));

		expect((await detailOf(jobId)).priority).toBe(7);
	});

	it('SCHEDULED以外は409', async () => {
		// QUEUED以降は投入済みなので予定を変えても実行は止まらない
		const jobId = await seedJob();
		const res = await post(`/api/jobs/${encodeURIComponent(jobId)}/reschedule`, { runAt: T0 + 60_000 });
		expect(res.status).toBe(409);
	});

	it('DOに無いジョブは410', async () => {
		const res = await post('/api/jobs/REST%230:missingjob/reschedule', { runAt: T0 + 60_000 });
		expect(res.status).toBe(410);
	});

	it('検証に落ちた本文は400', async () => {
		const jobId = await scheduled(T0 + 3_600_000);
		const res = await post(`/api/jobs/${encodeURIComponent(jobId)}/reschedule`, { runAt: T0, delayMs: 1_000 });
		expect(res.status).toBe(400);
	});

	it('不正な形式のジョブIDは400', async () => {
		const res = await post('/api/jobs/not-a-job-id/reschedule', { runAt: T0 });
		expect(res.status).toBe(400);
	});
});

describe('runの開始', () => {
	// Run DOはexamples/basicの定義を持つので, 実際に開始できるのはそこにある名前だけ
	const flow = createFlow({ REST: Noop });
	const withFlows = defineTsumugi({
		performers: { REST: Noop },
		flows: { GREETINGS: flow<{ prefix: string }>((f) => void f.node('only', 'REST', { input: (i) => i })) },
		auth: bearerAuth(TOKEN),
	});

	const post = (body: unknown) =>
		withFlows.fetch!(
			new Request('https://example.com/api/runs', {
				method: 'POST',
				headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
				body: JSON.stringify(body),
			}),
			env as RestEnv,
			{ waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
		);

	it('idを指定して開始できる', async () => {
		const res = await post({ flow: 'GREETINGS', input: { prefix: 'rest' }, id: 'rest-start-1' });
		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({ id: 'GREETINGS:rest-start-1' });
	});

	it('runIdのローカル部に使えないidは400', async () => {
		// 区切り文字を含むidはrunIdへ往復できない
		const res = await post({ flow: 'GREETINGS', input: { prefix: 'rest' }, id: 'a/b' });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'invalid run id' });
	});

	it('未登録のflowは400', async () => {
		const res = await post({ flow: 'UNKNOWN', input: {} });
		expect(res.status).toBe(400);
	});

	it('Object.prototypeの名前を登録済みとして扱わない', async () => {
		await expect(withFlows.start(env as never, 'constructor' as never, {} as never)).rejects.toThrow(/flow is not registered/);
		await expect(withFlows.start(env as never, 'toString' as never, {} as never)).rejects.toThrow(/flow is not registered/);
	});
});
