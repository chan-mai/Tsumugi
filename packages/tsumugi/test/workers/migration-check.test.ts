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

const app = defineTsumugi({ performers: { MIG: Noop }, auth: bearerAuth(TOKEN) });

const call = (path: string, database: D1Database) =>
	app.fetch!(
		new Request(`https://example.com${path}`, { headers: { authorization: `Bearer ${TOKEN}` } }),
		{
			...env,
			TSUMUGI_DB: database,
		} as RestEnv,
		{ waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
	);

/**
 * 台帳の応答だけ差し替えたD1を返す, 実際のテスト用D1は壊さない
 *
 * D1のメソッドはプロトタイプにあり展開では失われる
 * `prepare`しか使わない経路では気づけず, `batch`を通した時に初めて壊れる
 */
function proxyD1(onMigrationsQuery: () => D1PreparedStatement): D1Database {
	const base = env.TSUMUGI_DB;
	return new Proxy(base, {
		get(target, prop, receiver) {
			if (prop === 'prepare') {
				return (query: string) => (query.includes('d1_migrations') ? onMigrationsQuery() : target.prepare(query));
			}
			const value = Reflect.get(target, prop, receiver);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
}

const ledgerOf = (rows: { name: string }[]) => ({ all: async () => ({ results: rows }) }) as unknown as D1PreparedStatement;

function withLedger(rows: { name: string }[] | 'missing'): D1Database {
	return proxyD1(() => {
		if (rows === 'missing') throw new Error('no such table: d1_migrations');
		return ledgerOf(rows);
	});
}

/** 台帳の欠如ではない一時障害を起こすD1 */
function withError(message: string): D1Database {
	return proxyD1(() => {
		throw new Error(message);
	});
}

describe('マイグレーション適用漏れの検出', () => {
	it('全て適用済みなら通る', async () => {
		const status = await checkMigrations(withLedger(EXPECTED_MIGRATIONS.map((name) => ({ name }))));
		expect(status).toEqual({ ok: true });
	});

	it('欠けていれば名前を返す', async () => {
		const status = await checkMigrations(withLedger([{ name: '0001_create_job_read_model.sql' }]));
		expect(status).toEqual({ ok: false, missing: ['0002_add_attempt_log.sql', '0003_add_result.sql'] });
	});

	it('台帳自体が無ければ全件未適用として扱う', async () => {
		// 一度も適用していない状態, 例外をそのまま出すと原因が分からない
		const status = await checkMigrations(withLedger('missing'));
		expect(status).toEqual({ ok: false, missing: [...EXPECTED_MIGRATIONS] });
	});

	it('一時障害はunavailableとして扱い未適用と区別する(#8)', async () => {
		// D1の一時障害を未適用と混同すると, 適用済みの環境に誤った復旧手順を案内する
		const status = await checkMigrations(withError('D1_ERROR: Network connection lost'));
		expect(status).toEqual({ ok: false, unavailable: true });
	});

	it('一時障害では適用漏れの復旧手順を案内しない(#8)', async () => {
		// unavailableはTTLで使い回されるので, 共有appのキャッシュを汚さないよう専用のappを立てる
		const isolated = defineTsumugi({ performers: { MIG: Noop }, auth: bearerAuth(TOKEN) });
		const res = await isolated.fetch!(
			new Request('https://example.com/api/jobs', { headers: { authorization: `Bearer ${TOKEN}` } }),
			{ ...env, TSUMUGI_DB: withError('D1_ERROR: Network connection lost') } as RestEnv,
			{ waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
		);
		expect(res.status).toBe(503);

		const body = await res.json<{ error: string }>();
		expect(body.error).not.toContain('wrangler d1 migrations apply');
		expect(body.error).toContain('temporarily unavailable');
	});

	it('一時障害の結果は短いTTLで使い回しD1を叩き直さない(#8)', async () => {
		let calls = 0;
		let clock = 1_000;
		const failing = proxyD1(() => {
			calls++;
			throw new Error('D1_ERROR: down');
		});
		const check = cachedCheck(() => clock);

		expect((await check(failing)).ok).toBe(false);
		// TTL内なので叩き直さない, 障害中にクエリが最大になるのを防ぐ
		expect((await check(failing)).ok).toBe(false);
		expect(calls).toBe(1);

		// TTLを過ぎたら再検査する
		clock += 5_001;
		await check(failing);
		expect(calls).toBe(2);
	});

	it('一時障害から復帰すると次の検査で通る(#8)', async () => {
		let down = true;
		let clock = 1_000;
		const flipping = proxyD1(() => {
			if (down) throw new Error('D1_ERROR: down');
			return ledgerOf(EXPECTED_MIGRATIONS.map((name) => ({ name })));
		});
		const check = cachedCheck(() => clock);

		expect((await check(flipping)).ok).toBe(false);
		down = false;
		clock += 5_001;
		expect((await check(flipping)).ok).toBe(true);
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

	it('batchを使う経路も通る', async () => {
		// 展開でモックを作るとプロトタイプのメソッドが落ち, ここで初めて壊れる
		const res = await call('/api/jobs', withLedger(EXPECTED_MIGRATIONS.map((name) => ({ name }))));
		expect(res.status).toBe(200);
	});

	it('通った結果は使い回してD1を叩き直さない', async () => {
		let calls = 0;
		const counting = proxyD1(() => {
			calls++;
			return ledgerOf(EXPECTED_MIGRATIONS.map((name) => ({ name })));
		});

		const check = cachedCheck();
		await check(counting);
		await check(counting);
		await check(counting);
		expect(calls).toBe(1);
	});

	it('未適用の結果は使い回さない, 適用後に自力で復帰する', async () => {
		let applied = false;
		const flipping = proxyD1(() =>
			ledgerOf(applied ? EXPECTED_MIGRATIONS.map((name) => ({ name })) : [{ name: '0001_create_job_read_model.sql' }]),
		);

		const check = cachedCheck();
		expect((await check(flipping)).ok).toBe(false);
		applied = true;
		// 失敗を握り続けると,適用してもWorkerを再デプロイするまで復帰しない
		expect((await check(flipping)).ok).toBe(true);
	});
});
