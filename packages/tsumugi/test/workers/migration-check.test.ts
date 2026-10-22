import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { bearerAuth } from '../../src/api/auth.js';
import type { RestEnv } from '../../src/api/rest.js';
import { Performer } from '../../src/performer/entrypoint.js';
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

// D1メソッドはプロトタイプ上で展開時に欠落, `batch`実行時のみ失敗
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
		// 期待値は定義から導出, マイグレーション追加ごとの書き換え回避
		const [first, ...rest] = EXPECTED_MIGRATIONS;
		const status = await checkMigrations(withLedger([{ name: first }]));
		expect(status).toEqual({ ok: false, missing: rest });
	});

	it('台帳自体が無ければ全件未適用として扱う', async () => {
		// 未適用状態, 例外をそのまま返すと原因不明
		const status = await checkMigrations(withLedger('missing'));
		expect(status).toEqual({ ok: false, missing: [...EXPECTED_MIGRATIONS] });
	});

	it('一時障害はunavailableとして扱い未適用と区別する(#8)', async () => {
		// 一時障害を未適用と混同すると適用済み環境へ誤った復旧手順を案内
		const status = await checkMigrations(withError('D1_ERROR: Network connection lost'));
		expect(status).toEqual({ ok: false, unavailable: true });
	});

	it('一時障害では適用漏れの復旧手順を案内しない(#8)', async () => {
		// unavailableはTTL内再利用、共有appのキャッシュへの影響回避で専用app
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

	it('一時障害の結果は短いTTLで再利用しD1へ再問い合わせしない(#8)', async () => {
		let calls = 0;
		let clock = 1_000;
		const failing = proxyD1(() => {
			calls++;
			throw new Error('D1_ERROR: down');
		});
		const check = cachedCheck(() => clock);

		expect((await check(failing)).ok).toBe(false);
		// TTL内は再問い合わせなし, 障害中のクエリ増加を防止
		expect((await check(failing)).ok).toBe(false);
		expect(calls).toBe(1);

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
		// 展開でのモック作成ではプロトタイプのメソッドが欠落、ここで初めて失敗
		const res = await call('/api/jobs', withLedger(EXPECTED_MIGRATIONS.map((name) => ({ name }))));
		expect(res.status).toBe(200);
	});

	it('成功した結果は再利用してD1へ再問い合わせしない', async () => {
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

	it('未適用の結果は再利用しない, 適用後に自動で復帰する', async () => {
		let applied = false;
		const flipping = proxyD1(() =>
			ledgerOf(applied ? EXPECTED_MIGRATIONS.map((name) => ({ name })) : [{ name: '0001_create_job_read_model.sql' }]),
		);

		const check = cachedCheck();
		expect((await check(flipping)).ok).toBe(false);
		applied = true;
		// 失敗保持時は適用後もWorker再デプロイまで未復帰
		expect((await check(flipping)).ok).toBe(true);
	});
});
