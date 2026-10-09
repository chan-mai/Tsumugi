import { env, runInDurableObject } from 'cloudflare:test';
import { and, asc, eq, lte } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { JobRepo } from '../../src/do/repo.js';
import { applySchema } from '../../src/do/schema.js';
import { job } from '../../src/do/tables.js';

const T0 = 2_400_000_000_000;
const N = 2_000;
const LIMIT = 200;

const shard = (name: string) => env.JOB_SHARD.get(env.JOB_SHARD.idFromName(name));

/** 指定状態のジョブをN件直接挿入 */
function seed(sql: SqlStorage, state: string, runAfter: number, updatedAt: number): void {
	sql.exec(
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
		INSERT INTO job (id, binding, state, max_attempts, guarantee, timeout_ms, backoff, run_after, created_at, updated_at, payload)
		SELECT ?2 || printf('%06d', i), 'READS', ?2, 1, 'at-least-once', 60000, '{}', ?3, ?4 - i, ?4, '{}' FROM n`,
		N,
		state,
		runAfter,
		updatedAt,
	);
}

/**
 * 滞留件数に比例する読み取りの防止(#104)
 * tickごとに滞留全件を読むと、解消までの読み取り行数が件数の2乗に比例
 */
describe('tickの読み取り行数', () => {
	it('実行可能ジョブの滞留中もreadyの読み取りはlimit程度', async () => {
		await runInDurableObject(shard('READS1#0'), (instance) => {
			const repo = (instance as any).repo as JobRepo;
			seed(repo.sql, 'SCHEDULED', T0, T0);

			// scheduleWindowのreadyと同形
			const { sql: text, params } = repo.db
				.select()
				.from(job)
				.where(and(eq(job.state, 'SCHEDULED'), lte(job.runAfter, T0)))
				.orderBy(asc(job.runAfter), asc(job.id))
				.limit(LIMIT)
				.toSQL();

			const plan = repo.sql
				.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${text}`, ...(params as SqlStorageValue[]))
				.toArray()
				.map((r) => r.detail)
				.join('\n');
			expect(plan).toContain('job_due');
			expect(plan).not.toContain('TEMP B-TREE');

			const cursor = repo.sql.exec(text, ...(params as SqlStorageValue[]));
			expect(cursor.toArray()).toHaveLength(LIMIT);
			expect(cursor.rowsRead).toBeLessThan(N / 2);
		});
	});

	it('終端ジョブが多くてもsweepStateの読み取りは件数に比例しない', async () => {
		await runInDurableObject(shard('READS2#0'), (instance) => {
			const repo = (instance as any).repo as JobRepo;
			seed(repo.sql, 'FAILED', T0, T0);

			const original = repo.sql;
			const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
			(repo as any).sql = {
				exec: (query: string, ...bindings: SqlStorageValue[]) => {
					const cursor = original.exec(query, ...bindings);
					cursors.push(cursor);
					return cursor;
				},
			};
			try {
				const state = repo.sweepState(T0 + 1, { doneMs: 60_000, failedMs: 60_000 });
				expect(state).toEqual({ jobs: false, uniqueKeys: false, nextDueAt: T0 + 60_000 });
			} finally {
				(repo as any).sql = original;
			}
			expect(cursors).toHaveLength(1);
			expect(cursors[0]!.rowsRead).toBeLessThan(N / 2);
		});
	});

	it('next_dueは状態ごとの保持期間で最小を取る', async () => {
		await runInDurableObject(shard('READS3#0'), (instance) => {
			const repo = (instance as any).repo as JobRepo;
			seed(repo.sql, 'COMPLETED', T0, T0);
			seed(repo.sql, 'STALLED', T0, T0 - 1_000);

			// STALLEDは古いが保持が長く、COMPLETED側が先に対象となる
			expect(repo.sweepState(T0, { doneMs: 10_000, failedMs: 60_000 }).nextDueAt).toBe(T0 + 10_000);
			expect(repo.sweepState(T0, { doneMs: 60_000, failedMs: 10_000 }).nextDueAt).toBe(T0 - 1_000 + 10_000);
		});
	});

	it('既存DOの旧インデックスを置き換える', async () => {
		await runInDurableObject(shard('READS4#0'), (instance) => {
			const sql = ((instance as any).repo as JobRepo).sql;
			sql.exec(`DROP INDEX IF EXISTS job_due`);
			sql.exec(`DROP INDEX IF EXISTS job_terminal`);
			sql.exec(`CREATE INDEX job_active ON job (state, run_after)`);

			applySchema(sql);

			const names = sql
				.exec<{ name: string }>(`SELECT name FROM pragma_index_list('job')`)
				.toArray()
				.map((r) => r.name);
			expect(names).toEqual(expect.arrayContaining(['job_due', 'job_terminal']));
			expect(names).not.toContain('job_active');
		});
	});
});
