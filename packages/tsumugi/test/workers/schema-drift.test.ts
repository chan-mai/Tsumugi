import { env, runInDurableObject } from 'cloudflare:test';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { attempt, failureNotify, job, outbox, setting, settledNotify, uniqueKey } from '../../src/do/tables.js';
import { schedule, schedulerSetting } from '../../src/do/scheduler-tables.js';
import { job as readModel } from '../../src/projection/tables.js';

// DOのテーブルは`schema.ts`のDDLで作成, クエリは`tables.ts`で構築
// 片方のみの修正では型検査成功でも実行時に列欠落
describe('DDLとDrizzle定義の一致', () => {
	const shard = env.JOB_SHARD.get(env.JOB_SHARD.idFromName('DRIFT#0'));

	const columnsOf = (table: string) =>
		runInDurableObject(shard, (instance) => {
			const sql = (instance as any).repo.sql as SqlStorage;
			return sql
				.exec<{ name: string }>(`SELECT name FROM pragma_table_info(?)`, table)
				.toArray()
				.map((r) => r.name)
				.sort();
		});

	for (const table of [job, attempt, uniqueKey, setting, outbox, failureNotify, settledNotify]) {
		const config = getTableConfig(table);

		it(`${config.name}の列が一致する`, async () => {
			const declared = config.columns.map((c) => c.name).sort();
			const actual = await columnsOf(config.name);

			expect(actual.length).toBeGreaterThan(0);
			expect(actual).toEqual(declared);
		});
	}
});

// Scheduler DOも`scheduler-schema.ts`と`scheduler-tables.ts`の二重管理(ADR-0040)
describe('Scheduler DOのDDLとDrizzle定義の一致', () => {
	// DO型直接参照でTS2589発生, 呼び出しなしで空宣言
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

// D1読み取りモデルも`migrations/`のDDLと`projection/tables.ts`の二重管理
describe('D1のDDLとDrizzle定義の一致', () => {
	it('jobの列が一致する', async () => {
		const config = getTableConfig(readModel);
		const { results } = await env.TSUMUGI_DB.prepare(`SELECT name FROM pragma_table_info('job')`).all<{ name: string }>();

		const actual = results.map((r) => r.name).sort();
		expect(actual.length).toBeGreaterThan(0);
		expect(actual).toEqual(config.columns.map((c) => c.name).sort());
	});
});
