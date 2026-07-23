import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { schedule } from '../../src/core/schedule.js';
import { canTransition } from '../../src/core/transitions.js';
import type { Decision, JobState, JobView, ScheduleInput } from '../../src/core/types.js';
import { scheduleInput } from './schedule-arbitraries.js';
import { expectedDispatchIds } from './schedule-model.js';

/**
 * schedule()の不変条件をproperty-based testで固める
 *
 * テーブル駆動は境界を突くが組み合わせの隙間が空く
 * perKeyConcurrency > 1やreaperとレート制限の同時発火は, ここで初めて広く踏まれる
 */

const RUNS = 500;

const activeById = (input: ScheduleInput) => new Map(input.jobs.map((j) => [j.id, j]));
const dispatches = (decisions: Decision[]) => decisions.filter((d) => d.type === 'dispatch');

/** 回収後にin-flightとして残るジョブ数, dispatch枠の基準 */
function inFlightAfterReap(input: ScheduleInput, decisions: Decision[]): number {
	const reaped = new Set(decisions.filter((d) => d.type !== 'dispatch').map((d) => d.id));
	return input.jobs.filter((j) => (j.state === 'QUEUED' || j.state === 'RUNNING') && !reaped.has(j.id)).length;
}

describe('schedule()の不変条件', () => {
	it('dispatch数が同時実行の空き枠を超えない', () => {
		fc.assert(
			fc.property(scheduleInput, (input) => {
				const out = schedule(input);
				const slots = Math.max(0, input.policy.concurrency - inFlightAfterReap(input, out.decisions));
				expect(dispatches(out.decisions).length).toBeLessThanOrEqual(slots);
			}),
			{ numRuns: RUNS },
		);
	});

	it('どのキーもperKeyConcurrencyと既存数の大きい方を超えない', () => {
		fc.assert(
			fc.property(scheduleInput, (input) => {
				const out = schedule(input);
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
					// 既にスナップショットが上限を超えていてもdispatchで増やさなければ許容する
					const ceiling = Math.max(input.policy.perKeyConcurrency, existing.get(key) ?? 0);
					expect(count, `key ${key}`).toBeLessThanOrEqual(ceiling);
				}
			}),
			{ numRuns: RUNS },
		);
	});

	it('トークンが保存され非負, rate無しなら常にInfinity', () => {
		fc.assert(
			fc.property(scheduleInput, (input) => {
				const out = schedule(input);
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

	it('1ジョブに2つの決定が出ない', () => {
		fc.assert(
			fc.property(scheduleInput, (input) => {
				const ids = schedule(input).decisions.map((d) => d.id);
				expect(new Set(ids).size).toBe(ids.length);
			}),
			{ numRuns: RUNS },
		);
	});

	it('全ての決定が合法な状態遷移', () => {
		const target: Record<Decision['type'], JobState> = {
			dispatch: 'QUEUED',
			reap: 'SCHEDULED',
			stall: 'STALLED',
			fail: 'FAILED',
		};
		fc.assert(
			fc.property(scheduleInput, (input) => {
				const out = schedule(input);
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
			fc.property(scheduleInput, (input) => {
				const snapshot = structuredClone(input);
				schedule(input);
				expect(input).toEqual(snapshot);
			}),
			{ numRuns: RUNS },
		);
	});

	it('決定的で, jobsの並べ替えでdispatchのid集合が変わらない', () => {
		fc.assert(
			fc.property(scheduleInput, fc.integer(), (input, seed) => {
				const first = schedule(input);
				expect(schedule(input)).toEqual(first);

				const shuffled: ScheduleInput = { ...input, jobs: shuffle(input.jobs, seed) };
				const second = schedule(shuffled);
				expect(new Set(dispatches(second.decisions).map((d) => d.id))).toEqual(new Set(dispatches(first.decisions).map((d) => d.id)));
			}),
			{ numRuns: RUNS },
		);
	});

	it('dispatchの決定が独立な参照モデルと一致する', () => {
		// 上限だけの検査は枠を広げる変異を相殺で見逃す, あるべき結果を実装と別に計算して丸ごと突き合わせる
		fc.assert(
			fc.property(scheduleInput, (input) => {
				const actual = dispatches(schedule(input).decisions).map((d) => d.id);
				expect(actual).toEqual(expectedDispatchIds(input));
			}),
			{ numRuns: RUNS },
		);
	});

	it('dispatch以外の決定があればnextAlarmAtはnowになる', () => {
		fc.assert(
			fc.property(scheduleInput, (input) => {
				const out = schedule(input);
				if (out.decisions.some((d) => d.type !== 'dispatch')) {
					expect(out.nextAlarmAt).toBe(input.now);
				}
			}),
			{ numRuns: RUNS },
		);
	});
});

/** 決定的なシャッフル, seedからの単純な並べ替え */
function shuffle(jobs: readonly JobView[], seed: number): JobView[] {
	return [...jobs]
		.map((job, i) => ({ job, key: Math.sin(seed + i) }))
		.sort((a, b) => a.key - b.key)
		.map((x) => x.job);
}
