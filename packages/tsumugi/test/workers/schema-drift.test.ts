import { env, runInDurableObject } from 'cloudflare:test';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { attempt, job, outbox, setting, uniqueKey } from '../../src/do/tables.js';
import { schedule, schedulerSetting } from '../../src/do/scheduler-tables.js';
import { job as readModel } from '../../src/projection/tables.js';

/**
 * DDLとDrizzleの定義がずれたら落とす
 *
 * DOのテーブルは`schema.ts`の`CREATE TABLE`が作り, クエリは`tables.ts`の定義で組み立てる
 * 片方だけ直すと,型は通るのに実行時に列が無いという壊れ方をする
 */
describe('DDLとDrizzle定義の一致', () => {
	const shard = env.JOB_SHARD.get(env.JOB_SHARD.idFromName('DRIFT#0'));

	/** DDLが実際に作った列名, DOを一度起こしてSQLiteに問い合わせる */
	const columnsOf = (table: string) =>
		runInDurableObject(shard, (instance) => {
			const sql = (instance as any).repo.sql as SqlStorage;
			return sql
				.exec<{ name: string }>(`SELECT name FROM pragma_table_info(?)`, table)
				.toArray()
				.map((r) => r.name)
				.sort();
		});

	for (const table of [job, attempt, uniqueKey, setting, outbox]) {
		const config = getTableConfig(table);

		it(`${config.name}の列が一致する`, async () => {
			const declared = config.columns.map((c) => c.name).sort();
			const actual = await columnsOf(config.name);

			expect(actual.length).toBeGreaterThan(0);
			expect(actual).toEqual(declared);
		});
	}
});

/** Scheduler DOも`scheduler-schema.ts`と`scheduler-tables.ts`の二重管理(ADR-0040) */
describe('Scheduler DOのDDLとDrizzle定義の一致', () => {
	// 面をそのまま通すと型の展開が深くなりTS2589に触れる, ここでは呼ばないので空で受ける
	interface SchedulerFace extends Rpc.DurableObjectBranded {}
	const namespace = env.SCHEDULER as unknown as DurableObjectNamespace<SchedulerFace>;
	const stub = namespace.get(namespace.idFromName('scheduler'));

	const columnsOf = (table: string) =>
		runInDurableObject(stub, (instance) =>
			((instance as any).repo.sql as SqlStorage)
				.exec<{ name: string }>(`SELECT name FROM pragma_table_info(?)`, table)
				.toArray()
				.map((r) => r.name)
				.sort(),
		);

	for (const table of [schedule, schedulerSetting]) {
		const config = getTableConfig(table);

		it(`${config.name}の列が一致する`, async () => {
			const actual = await columnsOf(config.name);
			expect(actual.length).toBeGreaterThan(0);
			expect(actual).toEqual(config.columns.map((c) => c.name).sort());
		});
	}
});

/**
 * D1の読み取りモデルも同じ問題を持つ
 * DDLは`migrations/`のSQLが作り, クエリは`projection/tables.ts`の定義で組み立てる
 */
describe('D1のDDLとDrizzle定義の一致', () => {
	it('jobの列が一致する', async () => {
		const config = getTableConfig(readModel);
		const { results } = await env.TSUMUGI_DB.prepare(`SELECT name FROM pragma_table_info('job')`).all<{ name: string }>();

		const actual = results.map((r) => r.name).sort();
		expect(actual.length).toBeGreaterThan(0);
		expect(actual).toEqual(config.columns.map((c) => c.name).sort());
	});
});
