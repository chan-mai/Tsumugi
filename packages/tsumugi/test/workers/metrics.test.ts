import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { toPoint, writeMetrics, type MetricPoint } from '../../src/analytics/writer.js';
import type { JobRow } from '../../src/do/schema.js';

const T0 = 2_300_000_000_000;

const row = (over: Partial<JobRow> = {}): JobRow => ({
	id: 'MET#0:abc',
	binding: 'MET',
	state: 'COMPLETED',
	priority: 0,
	attempts: 1,
	max_attempts: 3,
	concurrency_key: null,
	unique_key: null,
	guarantee: 'at-least-once',
	timeout_ms: 60_000,
	backoff: '{}',
	run_after: T0,
	created_at: T0,
	updated_at: T0 + 5_000,
	dispatched_at: T0 + 1_000,
	payload: '{}',
	result: null,
	run_id: null,
	node_id: null,
	...over,
});

function captureDataset() {
	const points: MetricPoint[] = [];
	return {
		points,
		dataset: { writeDataPoint: (point: MetricPoint) => void points.push(point) } as unknown as AnalyticsEngineDataset,
	};
}

const shard = (name: string) => env.JOB_SHARD.get(env.JOB_SHARD.idFromName(name));

describe('計測点の組み立て', () => {
	it('終端に達した遷移だけを書く', () => {
		for (const state of ['COMPLETED', 'FAILED', 'CANCELLED', 'STALLED']) {
			expect(toPoint(row({ state }))).not.toBeNull();
		}
		// 途中の遷移まで書くと件数が3倍になり得るものが増えない
		for (const state of ['SCHEDULED', 'QUEUED', 'RUNNING']) {
			expect(toPoint(row({ state }))).toBeNull();
		}
	});

	it('bindingをindexに置く', () => {
		expect(toPoint(row())?.indexes).toEqual(['MET']);
	});

	it('試行回数と所要時間を持つ', () => {
		const point = toPoint(row({ attempts: 3, dispatched_at: T0 + 1_000, updated_at: T0 + 4_000 }));
		expect(point?.doubles).toEqual([3, 3_000]);
	});

	it('実行に至らず終わったジョブは所要0', () => {
		const point = toPoint(row({ state: 'CANCELLED', dispatched_at: null }));
		expect(point?.doubles[1]).toBe(0);
	});

	it('状態とbindingとguaranteeを持つ', () => {
		expect(toPoint(row({ guarantee: 'at-most-once' }))?.blobs).toEqual(['COMPLETED', 'MET', 'at-most-once']);
	});
});

describe('書き出し', () => {
	it('終端の件数だけ書かれる', () => {
		const { points, dataset } = captureDataset();
		const written = writeMetrics(dataset, [row(), row({ state: 'QUEUED' }), row({ state: 'FAILED' })]);
		expect(written).toBe(2);
		expect(points).toHaveLength(2);
	});

	it('バインディング未設定なら何もしない', () => {
		expect(writeMetrics(undefined, [row()])).toBe(0);
	});
});

describe('tickからの書き出し', () => {
	it('ジョブが終端に達するとメトリクスが書かれる', async () => {
		const { points, dataset } = captureDataset();
		const stub = shard('MET#0');

		await runInDurableObject(stub, (instance) => {
			(instance as any).clock = { now: () => T0 };
			(instance as any).env.TSUMUGI_QUEUE = { send: async () => {}, sendBatch: async () => {} };
			(instance as any).env.TSUMUGI_METRICS = dataset;
		});

		const jobId = await stub.enqueue({ binding: 'MET', payload: {} });
		await runDurableObjectAlarm(stub);
		// ここまではSCHEDULEDとQUEUEDだけなので何も書かれない
		expect(points).toHaveLength(0);

		await runInDurableObject(stub, (instance) => {
			(instance as any).clock = { now: () => T0 + 3_000 };
			(instance as any).env.TSUMUGI_METRICS = dataset;
		});
		await stub.report(jobId, { ok: true });
		await runDurableObjectAlarm(stub);

		expect(points).toHaveLength(1);
		expect(points[0]).toMatchObject({ indexes: ['MET'], blobs: ['COMPLETED', 'MET', 'at-least-once'] });
	});

	it('sweepで明細を消してもメトリクスは残る', async () => {
		// メトリクスはAnalytics Engine側にあるのでD1の明細とは寿命が別(ADR-0016)
		const { points, dataset } = captureDataset();
		const stub = shard('MET2#0');

		await runInDurableObject(stub, (instance) => {
			(instance as any).clock = { now: () => T0 };
			(instance as any).env.TSUMUGI_QUEUE = { send: async () => {}, sendBatch: async () => {} };
			(instance as any).env.TSUMUGI_METRICS = dataset;
		});
		const jobId = await stub.enqueue({ binding: 'MET2', payload: {} });
		await runDurableObjectAlarm(stub);
		await stub.report(jobId, { ok: true });
		await runDurableObjectAlarm(stub);
		expect(points.length).toBeGreaterThan(0);

		await env.TSUMUGI_DB.prepare('DELETE FROM job WHERE id = ?').bind(jobId).run();
		const remaining = await env.TSUMUGI_DB.prepare('SELECT id FROM job WHERE id = ?').bind(jobId).first();

		expect(remaining).toBeNull();
		expect(points.length).toBeGreaterThan(0);
	});

	it('writeMetricsが失敗してもtickは止まらずカーソルが進む(#7)', async () => {
		// writeDataPointが例外を投げる状況, メトリクスは省略可能なのでtickを止めてはいけない
		const boom = {
			writeDataPoint: () => {
				throw new Error('AE不調');
			},
		} as unknown as AnalyticsEngineDataset;
		const stub = shard('MET3#0');

		await runInDurableObject(stub, (instance) => {
			(instance as any).clock = { now: () => T0 };
			(instance as any).env.TSUMUGI_QUEUE = { send: async () => {}, sendBatch: async () => {} };
			(instance as any).env.TSUMUGI_METRICS = boom;
		});
		const jobId = await stub.enqueue({ binding: 'MET3', payload: {} });
		await runDurableObjectAlarm(stub);

		await runInDurableObject(stub, (instance) => {
			(instance as any).clock = { now: () => T0 + 3_000 };
			(instance as any).env.TSUMUGI_METRICS = boom;
		});
		await stub.report(jobId, { ok: true });
		await runDurableObjectAlarm(stub);

		// 投影はメトリクスの失敗に巻き込まれずD1へ届く
		const projected = await env.TSUMUGI_DB.prepare('SELECT state FROM job WHERE id = ?').bind(jobId).first<{ state: string }>();
		expect(projected?.state).toBe('COMPLETED');
		// カーソルが進みアウトボックスが残らない, 残ると次tickで同じメトリクスを二重書きする
		const outbox = await runInDurableObject(stub, (instance) => (instance as any).repo.countOutbox() as number);
		expect(outbox).toBe(0);
	});
});
