import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { planDispatch } from '../../src/core/dispatch.js';
import { canTransition } from '../../src/core/transitions.js';
import type { Decision, JobState, JobView, DispatchInput } from '../../src/core/types.js';
import { dispatchInput } from './dispatch-arbitraries.js';
import { expectedDispatchIds } from './dispatch-model.js';

// テーブル駆動では組み合わせの網羅不足, perKeyConcurrency > 1やreaperとレート制限の同時発火はここで検査

const RUNS = 500;

const activeById = (input: DispatchInput) => new Map(input.jobs.map((j) => [j.id, j]));
const dispatches = (decisions: Decision[]) => decisions.filter((d) => d.type === 'dispatch');

function inFlightAfterReap(input: DispatchInput, decisions: Decision[]): number {
	const reaped = new Set(decisions.filter((d) => d.type !== 'dispatch').map((d) => d.id));
	return input.jobs.filter((j) => (j.state === 'QUEUED' || j.state === 'RUNNING') && !reaped.has(j.id)).length;
}

describe('planDispatch()の不変条件', () => {
	it('dispatch数が同時実行の空き数を超えない', () => {
		fc.assert(
			fc.property(dispatchInput, (input) => {
				const out = planDispatch(input);
				const slots = Math.max(0, input.policy.concurrency - inFlightAfterReap(input, out.decisions));
				expect(dispatches(out.decisions).length).toBeLessThanOrEqual(slots);
			}),
			{ numRuns: RUNS },
		);
	});

	it('どのキーもperKeyConcurrencyと既存数の大きい方を超えない', () => {
		fc.assert(
			fc.property(dispatchInput, (input) => {
				const out = planDispatch(input);
				const reaped = new Set(out.decisions.filter((d) => d.type !== 'dispatch').map((d) => d.id));
				const byId = activeById(input);

				const existing = new Map<string, number>();
				for (const j of input.jobs) {
					if ((j.state === 'QUEUED' || j.state === 'RUNNING') && !reaped.has(j.id) && j.concurrencyKey !== null) {
						existing.set(j.concurrencyKey, (existing.get(j.concurrencyKey) ?? 0) + 1);
					}
				}

				const after = new Map(existing);
				for (const d of dispatches(out.decisions)) {
					const key = byId.get(d.id)?.concurrencyKey;
					if (key != null) after.set(key, (after.get(key) ?? 0) + 1);
				}

				for (const [key, count] of after) {
					// スナップショットが上限超過でもdispatchで不増なら許容
					const ceiling = Math.max(input.policy.perKeyConcurrency, existing.get(key) ?? 0);
					expect(count, `key ${key}`).toBeLessThanOrEqual(ceiling);
				}
			}),
			{ numRuns: RUNS },
		);
	});

	it('トークンが保存され非負, rate無しなら常にInfinity', () => {
		fc.assert(
			fc.property(dispatchInput, (input) => {
				const out = planDispatch(input);
				if (input.policy.rate === null) {
					expect(out.bucket.tokens).toBe(Number.POSITIVE_INFINITY);
					return;
				}
				expect(out.bucket.tokens).toBeGreaterThanOrEqual(0);
				expect(out.bucket.tokens).toBeLessThanOrEqual(input.policy.rate.tokens);
			}),
			{ numRuns: RUNS },
		);
	});

	it('各キーのdispatch数が補充後のキー別トークンを超えない', () => {
		fc.assert(
			fc.property(dispatchInput, (input) => {
				const rate = input.policy.perKeyRate;
				if (rate === null) return;
				const byId = activeById(input);
				const counts = new Map<string, number>();
				for (const d of dispatches(planDispatch(input).decisions)) {
					const key = byId.get(d.id)?.concurrencyKey;
					if (key != null) counts.set(key, (counts.get(key) ?? 0) + 1);
				}
				for (const [key, count] of counts) {
					const stored = input.keyBuckets?.[key];
					const refilled =
						stored === undefined
							? rate.tokens
							: Math.min(rate.tokens, stored.tokens + Math.max(0, input.now - stored.refilledAt) * (rate.tokens / rate.intervalMs));
					expect(count, `key ${key}`).toBeLessThanOrEqual(refilled);
				}
			}),
			{ numRuns: RUNS },
		);
	});

	it('出力のキー別バケットに上限到達のキーが残らない, perKeyRate無しなら空', () => {
		fc.assert(
			fc.property(dispatchInput, (input) => {
				const out = planDispatch(input);
				const rate = input.policy.perKeyRate;
				if (rate === null) {
					expect(out.keyBuckets).toEqual({});
					return;
				}
				for (const [key, b] of Object.entries(out.keyBuckets)) {
					expect(b.tokens, `key ${key}`).toBeGreaterThanOrEqual(0);
					expect(b.tokens, `key ${key}`).toBeLessThan(rate.tokens);
				}
			}),
			{ numRuns: RUNS },
		);
	});

	it('1ジョブに2つの決定が出ない', () => {
		fc.assert(
			fc.property(dispatchInput, (input) => {
				const ids = planDispatch(input).decisions.map((d) => d.id);
				expect(new Set(ids).size).toBe(ids.length);
			}),
			{ numRuns: RUNS },
		);
	});

	it('全ての決定が合法な状態遷移', () => {
		const target: Record<Decision['type'], JobState> = {
			dispatch: 'QUEUED',
			expire: 'CANCELLED',
			reap: 'SCHEDULED',
			stall: 'STALLED',
			fail: 'FAILED',
			cancel: 'CANCELLED',
		};
		fc.assert(
			fc.property(dispatchInput, (input) => {
				const out = planDispatch(input);
				const byId = activeById(input);
				for (const d of out.decisions) {
					const from = byId.get(d.id)!.state;
					expect(canTransition(from, target[d.type]), `${from} -> ${target[d.type]}`).toBe(true);
				}
			}),
			{ numRuns: RUNS },
		);
	});

	it('入力を変更しない', () => {
		fc.assert(
			fc.property(dispatchInput, (input) => {
				const snapshot = structuredClone(input);
				planDispatch(input);
				expect(input).toEqual(snapshot);
			}),
			{ numRuns: RUNS },
		);
	});

	it('決定的で, jobsの並べ替えでdispatchのid集合が変わらない', () => {
		fc.assert(
			fc.property(dispatchInput, fc.integer(), (input, seed) => {
				const first = planDispatch(input);
				expect(planDispatch(input)).toEqual(first);

				const shuffled: DispatchInput = { ...input, jobs: shuffle(input.jobs, seed) };
				const second = planDispatch(shuffled);
				expect(new Set(dispatches(second.decisions).map((d) => d.id))).toEqual(new Set(dispatches(first.decisions).map((d) => d.id)));
			}),
			{ numRuns: RUNS },
		);
	});

	it('dispatchの決定が独立な参照モデルと一致する', () => {
		// 上限のみの検査では上限を広げる変異の検出漏れ, 期待結果を独立に算出し全体を照合
		fc.assert(
			fc.property(dispatchInput, (input) => {
				const actual = dispatches(planDispatch(input).decisions).map((d) => d.id);
				expect(actual).toEqual(expectedDispatchIds(input));
			}),
			{ numRuns: RUNS },
		);
	});

	it('dispatch, expire, cancel以外の決定があればnextAlarmAtはnowになる', () => {
		// expireとcancelは同じtickで遷移が完結, 続きのtickの要求なし
		fc.assert(
			fc.property(dispatchInput, (input) => {
				const out = planDispatch(input);
				if (out.decisions.some((d) => d.type !== 'dispatch' && d.type !== 'expire' && d.type !== 'cancel')) {
					expect(out.nextAlarmAt).toBe(input.now);
				}
			}),
			{ numRuns: RUNS },
		);
	});

	it('取り消し要求済みのジョブはdispatchされない', () => {
		// 要求はreap後も保持、SCHEDULEDへ戻った後も投入なしでcancel(#95)
		fc.assert(
			fc.property(dispatchInput, (input) => {
				const out = planDispatch(input);
				const byId = activeById(input);
				for (const d of out.decisions) {
					if (d.type === 'dispatch') expect(byId.get(d.id)!.cancelRequestedAt).toBeNull();
				}
			}),
			{ numRuns: RUNS },
		);
	});
});

function shuffle(jobs: readonly JobView[], seed: number): JobView[] {
	return [...jobs]
		.map((job, i) => ({ job, key: Math.sin(seed + i) }))
		.sort((a, b) => a.key - b.key)
		.map((x) => x.job);
}
