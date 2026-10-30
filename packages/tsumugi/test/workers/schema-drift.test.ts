import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { COLUMNS } from '../../src/do/schema.js';
import { RUN_COLUMNS } from '../../src/do/run-schema.js';
import { SCHEDULER_COLUMNS } from '../../src/do/scheduler-schema.js';
import { READ_MODEL_COLUMNS } from '../../src/projection/columns.js';

// DDLとクエリの取得列の二重管理, 片方のみの修正では実行時に列欠落
const columnsIn = (instance: unknown, table: string) =>
	((instance as any).repo.sql as SqlStorage)
		.exec<{ name: string }>(`SELECT name FROM pragma_table_info(?)`, table)
		.toArray()
		.map((r) => r.name)
		.sort();

describe('Job DOのDDLと取得列の一致', () => {
	const shard = env.JOB_SHARD.get(env.JOB_SHARD.idFromName('DRIFT#0'));

	for (const [table, declared] of Object.entries(COLUMNS)) {
		it(`${table}の列が一致する`, async () => {
			const actual = await runInDurableObject(shard, (instance) => columnsIn(instance, table));
			expect(actual.length).toBeGreaterThan(0);
			expect(actual).toEqual([...declared].sort());
		});
	}
});

describe('Scheduler DOのDDLと取得列の一致', () => {
	// DO型直接参照でTS2589発生, 呼び出しなしで空宣言
	interface SchedulerFace extends Rpc.DurableObjectBranded {}
	const namespace = env.SCHEDULER as unknown as DurableObjectNamespace<SchedulerFace>;
	const stub = namespace.get(namespace.idFromName('scheduler'));

	for (const [table, declared] of Object.entries(SCHEDULER_COLUMNS)) {
		it(`${table}の列が一致する`, async () => {
			const actual = await runInDurableObject(stub, (instance) => columnsIn(instance, table));
			expect(actual.length).toBeGreaterThan(0);
			expect(actual).toEqual([...declared].sort());
		});
	}
});

describe('Run DOのDDLと取得列の一致', () => {
	// DO型直接参照でTS2589発生, 呼び出しなしで空宣言
	interface RunFace extends Rpc.DurableObjectBranded {}
	const namespace = env.RUN as unknown as DurableObjectNamespace<RunFace>;
	const stub = namespace.get(namespace.idFromName('GREETINGS:drift'));

	for (const [table, declared] of Object.entries(RUN_COLUMNS)) {
		it(`${table}の列が一致する`, async () => {
			const actual = await runInDurableObject(stub, (instance) => columnsIn(instance, table));
			expect(actual.length).toBeGreaterThan(0);
			expect(actual).toEqual([...declared].sort());
		});
	}
});

// D1読み取りモデルも`migrations/`のDDLと`projection/columns.ts`の二重管理
describe('D1のDDLと列定義の一致', () => {
	for (const [table, declared] of Object.entries(READ_MODEL_COLUMNS)) {
		it(`${table}の列が一致する`, async () => {
			const { results } = await env.TSUMUGI_DB.prepare(`SELECT name FROM pragma_table_info(?)`).bind(table).all<{ name: string }>();
			const actual = results.map((r) => r.name).sort();
			expect(actual.length).toBeGreaterThan(0);
			expect(actual).toEqual([...declared].sort());
		});
	}
});
