import fc from 'fast-check';
import type { Bucket, JobView, Policy, ScheduleInput } from '../../src/core/types.js';

/**
 * schedule()に渡せる正当な入力の生成器
 *
 * 守らないと偽陽性が出る制約(スケジューラ分析より):
 * - idは一意, reaperがSetでソートの同値比較が非対称なため重複で順序が未定義になる
 * - SCHEDULED ⟹ dispatchedAt === null
 * - QUEUED / RUNNING ⟹ dispatchedAt !== null, nullだと永久に回収されずDOが構築し得ない状態になる
 * - concurrencyKeyは小さな集合, 広い空間だと衝突せずキー制御が一度も効かない
 * - 時刻はnowからの相対, 絶対epochは縮小が効かない
 */

const NOW = 1_000_000;

/** キーはnullか小さな集合から, 衝突させてperKeyの分岐を踏ませる */
const concurrencyKey = fc.constantFrom(null, 'k0', 'k1', 'k2');

const guarantee = fc.constantFrom('at-least-once' as const, 'at-most-once' as const);

/** 1件のジョブ, dispatchedAtは状態から導く */
function jobOf(id: string): fc.Arbitrary<JobView> {
	const common = {
		id: fc.constant(id),
		priority: fc.integer({ min: -5, max: 5 }),
		maxAttempts: fc.integer({ min: 1, max: 5 }),
		attempts: fc.integer({ min: 0, max: 6 }),
		concurrencyKey,
		createdAt: fc.integer({ min: NOW - 3_600_000, max: NOW + 1_000 }),
		guarantee,
		timeoutMs: fc.integer({ min: 1, max: 300_000 }),
	};

	const scheduled = fc.record({
		...common,
		state: fc.constant('SCHEDULED' as const),
		runAfter: fc.integer({ min: NOW - 10_000, max: NOW + 10_000 }),
		dispatchedAt: fc.constant(null),
	});

	// QUEUED / RUNNINGはdispatchedAtを持つ, 沈黙判定の境界をまたぐよう幅を取る
	const inFlight = fc.record({
		...common,
		state: fc.constantFrom('QUEUED' as const, 'RUNNING' as const),
		runAfter: fc.integer({ min: NOW - 10_000, max: NOW + 10_000 }),
		dispatchedAt: fc.integer({ min: NOW - 600_000, max: NOW }),
	});

	return fc.oneof(scheduled, inFlight);
}

const policy: fc.Arbitrary<Policy> = fc.record({
	concurrency: fc.integer({ min: 0, max: 8 }),
	// 1件も無かった穴, 明示的に2以上を含める
	perKeyConcurrency: fc.integer({ min: 0, max: 3 }),
	rate: fc.oneof(
		fc.constant(null),
		fc.record({ tokens: fc.integer({ min: 1, max: 100 }), intervalMs: fc.integer({ min: 1, max: 60_000 }) }),
	),
	// null / 0 / 負 / 正, effectivePriorityの<=0分岐も踏む
	agingIntervalMs: fc.oneof(fc.constant(null), fc.integer({ min: -1, max: 600_000 })),
	reaperGraceMs: fc.integer({ min: 0, max: 60_000 }),
});

const bucket: fc.Arbitrary<Bucket> = fc.oneof(
	fc.record({
		tokens: fc.double({ min: 0, max: 200, noNaN: true }),
		refilledAt: fc.integer({ min: NOW - 600_000, max: NOW }),
	}),
	// レート無制限の側
	fc.record({ tokens: fc.constant(Number.POSITIVE_INFINITY), refilledAt: fc.constant(NOW) }),
);

export const scheduleInput: fc.Arbitrary<ScheduleInput> = fc
	.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 0, maxLength: 12 })
	.chain((ids) => fc.tuple(fc.tuple(...ids.map(jobOf)), policy, bucket))
	.map(([jobs, policy, bucket]) => ({ now: NOW, jobs, policy, bucket }));

export { NOW };
