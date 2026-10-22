import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('バインディングの疎通', () => {
	it('必要なバインディングが揃っている', () => {
		expect(env.JOB_SHARD).toBeDefined();
		expect(env.TSUMUGI_DB).toBeDefined();
		expect(env.TSUMUGI_QUEUE).toBeDefined();
		expect(env.TSUMUGI_METRICS).toBeDefined();
	});

	it('DOのSQLiteストレージが使える', async () => {
		const stub = env.JOB_SHARD.get(env.JOB_SHARD.idFromName('probe'));
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec('CREATE TABLE IF NOT EXISTS probe (id TEXT PRIMARY KEY)');
			state.storage.sql.exec("INSERT INTO probe (id) VALUES ('a')");
			const rows = state.storage.sql.exec<{ id: string }>('SELECT id FROM probe').toArray();
			expect(rows).toEqual([{ id: 'a' }]);
		});
	});
});
