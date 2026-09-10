import fc from 'fast-check';
import type { Bucket, JobView, KeyBuckets, Policy, ScheduleInput } from '../../src/core/types.js';

/**
 * schedule()に渡せる正当な入力の生成器
 *
 * 守らないと偽陽性が出る制約(スケジューラ分析より):
 * - idは一意, reaperがSetでソートの同値比較が非対称なため重複で順序が未定義
 * - SCHEDULED ⟹ dispatchedAt === null
 * - QUEUED / RUNNING ⟹ dispatchedAt !== null, nullでは永久に回収されずDOが構築し得ない状態
 * - concurrencyKeyは小さな集合, 広い空間だと衝突が無くキー制御の分岐が未実行
 * - 時刻はnowからの相対, 絶対epochでは縮小が無効
 */

const NOW = 1_000_000;

/** キーはnullか小さな集合から, 衝突させてperKeyの分岐を実行させるため */
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

	// 期限の境界(NOW)をまたぐよう幅を取る, nullは無期限
	const expiresAt = fc.oneof(fc.constant(null), fc.integer({ min: NOW - 10_000, max: NOW + 10_000 }));

	const scheduled = fc.record({
		...common,
		state: fc.constant('SCHEDULED' as const),
		runAfter: fc.integer({ min: NOW - 10_000, max: NOW + 10_000 }),
		expiresAt,
		dispatchedAt: fc.constant(null),
		heartbeatAt: fc.constant(null),
	});

	// QUEUED / RUNNINGはdispatchedAtを持つ, 無応答判定の境界をまたぐよう幅を取る
	const inFlight = fc.record({
		...common,
		state: fc.constantFrom('QUEUED' as const, 'RUNNING' as const),
		runAfter: fc.integer({ min: NOW - 10_000, max: NOW + 10_000 }),
		expiresAt,
		dispatchedAt: fc.integer({ min: NOW - 600_000, max: NOW }),
		heartbeatAt: fc.constant(null),
	});

	return fc.oneof(scheduled, inFlight);
}

const policy: fc.Arbitrary<Policy> = fc.record({
	// 停止中は投入しない, 性質はどちらの状態でも成り立つ(#27)
	paused: fc.boolean(),
	concurrency: fc.integer({ min: 0, max: 8 }),
	// 1件も無かった穴, 明示的に2以上を含める
	perKeyConcurrency: fc.integer({ min: 0, max: 3 }),
	rate: fc.oneof(
		fc.constant(null),
		fc.record({ tokens: fc.integer({ min: 1, max: 100 }), intervalMs: fc.integer({ min: 1, max: 60_000 }) }),
	),
	// 小さいtokensで枯渇の分岐を確実に実行
	perKeyRate: fc.oneof(
		fc.constant(null),
		fc.record({ tokens: fc.integer({ min: 1, max: 3 }), intervalMs: fc.integer({ min: 1, max: 60_000 }) }),
	),
	// null / 0 / 負 / 正, effectivePriorityの<=0分岐も実行
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

/** キー別バケット, キーはconcurrencyKeyと同じ集合から, undefinedの分岐で省略も検査 */
const keyBuckets: fc.Arbitrary<KeyBuckets | undefined> = fc.oneof(
	fc.constant(undefined),
	fc.dictionary(
		fc.constantFrom('k0', 'k1', 'k2'),
		fc.record({
			tokens: fc.double({ min: 0, max: 5, noNaN: true }),
			refilledAt: fc.integer({ min: NOW - 600_000, max: NOW }),
		}),
		{ maxKeys: 3 },
	),
);

export const scheduleInput: fc.Arbitrary<ScheduleInput> = fc
	.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 0, maxLength: 12 })
	.chain((ids) => fc.tuple(fc.tuple(...ids.map(jobOf)), policy, bucket, keyBuckets))
	// undefinedの分岐はプロパティごと省略, 省略時の既定(全キーtokens上限)も検査
	.map(([jobs, policy, bucket, keyBuckets]) =>
		keyBuckets === undefined ? { now: NOW, jobs, policy, bucket } : { now: NOW, jobs, policy, bucket, keyBuckets },
	);

export { NOW };
