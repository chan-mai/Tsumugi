import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { ensureColumns } from '../../src/do/columns.js';

const shard = env.JOB_SHARD.get(env.JOB_SHARD.idFromName('COLUMNS#0'));

it('不足列のみ追加し追加した列名を返す', async () => {
	const result = await runInDurableObject(shard, (_instance, state) => {
		const sql = state.storage.sql;
		sql.exec('CREATE TABLE legacy (id TEXT PRIMARY KEY, kept TEXT)');
		sql.exec(`INSERT INTO legacy (id, kept) VALUES ('a', 'x')`);
		const added = ensureColumns(sql, 'legacy', [
			['kept', 'TEXT'],
			['flag', 'INTEGER NOT NULL DEFAULT 0'],
		]);
		const again = ensureColumns(sql, 'legacy', [['flag', 'INTEGER NOT NULL DEFAULT 0']]);
		const row = sql.exec<{ kept: string; flag: number }>('SELECT kept, flag FROM legacy').one();
		return { added: [...added], again: [...again], row };
	});
	expect(result).toEqual({ added: ['flag'], again: [], row: { kept: 'x', flag: 0 } });
});
