import fc from 'fast-check';
import type { Bucket, JobView, KeyBuckets, Policy, ScheduleInput } from '../../src/core/types.js';

// 以下の制約違反は偽陽性の原因
// idは一意, 重複時はreaperのSetとソートの非対称な同値比較で順序が未定義
// QUEUED / RUNNINGならdispatchedAtは非null, nullは永久にreap対象外でDOが構築し得ない状態
// concurrencyKeyは小さな集合, 広い空間では衝突なしでキー制御の分岐が未実行
// 時刻はnowからの相対, 絶対epochでは縮小が無効

const NOW = 1_000_000;

const concurrencyKey = fc.constantFrom(null, 'k0', 'k1', 'k2');

const guarantee = fc.constantFrom('at-least-once' as const, 'at-most-once' as const);

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

	const expiresAt = fc.oneof(fc.constant(null), fc.integer({ min: NOW - 10_000, max: NOW + 10_000 }));

	const cancelRequestedAt = fc.oneof(fc.constant(null), fc.integer({ min: NOW - 60_000, max: NOW }));

	const scheduled = fc.record({
		...common,
		state: fc.constant('SCHEDULED' as const),
		runAfter: fc.integer({ min: NOW - 10_000, max: NOW + 10_000 }),
		expiresAt,
		dispatchedAt: fc.constant(null),
		heartbeatAt: fc.constant(null),
		cancelRequestedAt,
	});

	const inFlight = fc.record({
		...common,
		state: fc.constantFrom('QUEUED' as const, 'RUNNING' as const),
		runAfter: fc.integer({ min: NOW - 10_000, max: NOW + 10_000 }),
		expiresAt,
		dispatchedAt: fc.integer({ min: NOW - 600_000, max: NOW }),
		heartbeatAt: fc.constant(null),
		cancelRequestedAt,
	});

	return fc.oneof(scheduled, inFlight);
}

const policy: fc.Arbitrary<Policy> = fc.record({
	paused: fc.boolean(),
	concurrency: fc.integer({ min: 0, max: 8 }),
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
	// effectivePriorityの<=0分岐も実行
	agingIntervalMs: fc.oneof(fc.constant(null), fc.integer({ min: -1, max: 600_000 })),
	reaperGraceMs: fc.integer({ min: 0, max: 60_000 }),
});

const bucket: fc.Arbitrary<Bucket> = fc.oneof(
	fc.record({
		tokens: fc.double({ min: 0, max: 200, noNaN: true }),
		refilledAt: fc.integer({ min: NOW - 600_000, max: NOW }),
	}),
	fc.record({ tokens: fc.constant(Number.POSITIVE_INFINITY), refilledAt: fc.constant(NOW) }),
);

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
	// プロパティ省略時の既定(全キーtokens上限)も検査
	.map(([jobs, policy, bucket, keyBuckets]) =>
		keyBuckets === undefined ? { now: NOW, jobs, policy, bucket } : { now: NOW, jobs, policy, bucket, keyBuckets },
	);

export { NOW };
