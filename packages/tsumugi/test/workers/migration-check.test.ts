import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { bearerAuth } from '../../src/api/auth.js';
import type { RestEnv } from '../../src/api/rest.js';
import { Performer } from '../../src/core/api.js';
import { cachedCheck, checkMigrations, EXPECTED_MIGRATIONS } from '../../src/projection/migrations.js';
import { defineTsumugi } from '../../src/worker.js';

const TOKEN = 'secret-token';

class Noop extends Performer<unknown, void, {}, RestEnv> {
	async perform(): Promise<void> {}
}

const app = defineTsumugi<RestEnv>({ performers: { MIG: Noop }, auth: bearerAuth(TOKEN) });

const call = (path: string, database: D1Database) =>
	app.fetch!(
		new Request(`https://example.com${path}`, { headers: { authorization: `Bearer ${TOKEN}` } }),
		{
			...env,
			TSUMUGI_DB: database,
		} as RestEnv,
		{ waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
	);

/** 台帳を差し替えたD1に見せかける, 実際のテスト用D1は壊さない */
function withLedger(rows: { name: string }[] | 'missing'): D1Database {
	return {
		...env.TSUMUGI_DB,
		prepare(query: string) {
			if (query.includes('d1_migrations')) {
				if (rows === 'missing') throw new Error('no such table: d1_migrations');
				return { all: async () => ({ results: rows }) } as unknown as D1PreparedStatement;
			}
			return env.TSUMUGI_DB.prepare(query);
		},
	} as unknown as D1Database;
}

describe('マイグレーション適用漏れの検出', () => {
	it('全て適用済みなら通る', async () => {
		const status = await checkMigrations(withLedger(EXPECTED_MIGRATIONS.map((name) => ({ name }))));
		expect(status).toEqual({ ok: true });
	});

	it('欠けていれば名前を返す', async () => {
		const status = await checkMigrations(withLedger([{ name: '0001_create_job_read_model.sql' }]));
		expect(status).toEqual({ ok: false, missing: ['0002_add_attempt_log.sql'] });
	});

	it('台帳自体が無ければ全件未適用として扱う', async () => {
		// 一度も適用していない状態, 例外をそのまま出すと原因が分からない
		const status = await checkMigrations(withLedger('missing'));
		expect(status).toEqual({ ok: false, missing: [...EXPECTED_MIGRATIONS] });
	});

	it('未適用ならAPIが503と実行すべきコマンドを返す', async () => {
		const res = await call('/api/jobs', withLedger([{ name: '0001_create_job_read_model.sql' }]));
		expect(res.status).toBe(503);

		const body = await res.json<{ error: string }>();
		expect(body.error).toContain('0002_add_attempt_log.sql');
		expect(body.error).toContain('wrangler d1 migrations apply');
	});

	it('適用済みならAPIが通る', async () => {
		const res = await call('/api/stats', withLedger(EXPECTED_MIGRATIONS.map((name) => ({ name }))));
		expect(res.status).toBe(200);
	});

	it('通った結果は使い回してD1を叩き直さない', async () => {
		let calls = 0;
		const counting = {
			...env.TSUMUGI_DB,
			prepare(query: string) {
				if (query.includes('d1_migrations')) {
					calls++;
					return { all: async () => ({ results: EXPECTED_MIGRATIONS.map((name) => ({ name })) }) } as unknown as D1PreparedStatement;
				}
				return env.TSUMUGI_DB.prepare(query);
			},
		} as unknown as D1Database;

		const check = cachedCheck();
		await check(counting);
		await check(counting);
		await check(counting);
		expect(calls).toBe(1);
	});

	it('未適用の結果は使い回さない, 適用後に自力で復帰する', async () => {
		let applied = false;
		const flipping = {
			...env.TSUMUGI_DB,
			prepare(query: string) {
				if (query.includes('d1_migrations')) {
					const rows = applied ? EXPECTED_MIGRATIONS.map((name) => ({ name })) : [{ name: '0001_create_job_read_model.sql' }];
					return { all: async () => ({ results: rows }) } as unknown as D1PreparedStatement;
				}
				return env.TSUMUGI_DB.prepare(query);
			},
		} as unknown as D1Database;

		const check = cachedCheck();
		expect((await check(flipping)).ok).toBe(false);
		applied = true;
		// 失敗を握り続けると,適用してもWorkerを再デプロイするまで復帰しない
		expect((await check(flipping)).ok).toBe(true);
	});
});
