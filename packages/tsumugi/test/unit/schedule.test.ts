import { describe, expect, it } from 'vitest';
import { schedule } from '../../src/core/schedule.js';
import type { Bucket, Decision, JobView, Policy } from '../../src/core/types.js';

const T0 = 1_700_000_000_000;

const policy = (over: Partial<Policy> = {}): Policy => ({
	concurrency: 10,
	perKeyConcurrency: 1,
	rate: null,
	agingIntervalMs: null,
	reaperGraceMs: 30_000,
	...over,
});

const job = (over: Partial<JobView> & { id: string }): JobView => ({
	state: 'SCHEDULED',
	priority: 0,
	attempts: 0,
	maxAttempts: 3,
	concurrencyKey: null,
	runAfter: T0,
	createdAt: T0,
	dispatchedAt: null,
	heartbeatAt: null,
	guarantee: 'at-least-once',
	timeoutMs: 60_000,
	...over,
});

const unlimited: Bucket = { tokens: Number.POSITIVE_INFINITY, refilledAt: T0 };
const ids = (ds: Decision[], type: Decision['type']) => ds.filter((d) => d.type === type).map((d) => d.id);

describe('dispatchの基本', () => {
	it('実行可能なジョブを投入する', () => {
		const out = schedule({ now: T0, jobs: [job({ id: 'a' }), job({ id: 'b' })], policy: policy(), bucket: unlimited });
		expect(ids(out.decisions, 'dispatch')).toEqual(['a', 'b']);
	});

	it('runAfterが未来のジョブは投入せず,その時刻に起動する', () => {
		const out = schedule({
			now: T0,
			jobs: [job({ id: 'later', runAfter: T0 + 5_000 })],
			policy: policy(),
			bucket: unlimited,
		});
		expect(out.decisions).toEqual([]);
		expect(out.nextAlarmAt).toBe(T0 + 5_000);
	});

	it('runAfterちょうどは実行可能', () => {
		const out = schedule({ now: T0, jobs: [job({ id: 'a', runAfter: T0 })], policy: policy(), bucket: unlimited });
		expect(ids(out.decisions, 'dispatch')).toEqual(['a']);
	});

	it('同点ならcreatedAt,さらに同点ならidで決まる(再実行しても同じ結果)', () => {
		const jobs = [job({ id: 'c' }), job({ id: 'a' }), job({ id: 'b' })];
		const out = schedule({ now: T0, jobs, policy: policy(), bucket: unlimited });
		expect(ids(out.decisions, 'dispatch')).toEqual(['a', 'b', 'c']);
	});
});

describe('同時実行数の上限(ADR-0009)', () => {
	it('実行中の件数を差し引いた分までしか投入しない', () => {
		const jobs = [
			job({ id: 'run1', state: 'RUNNING', dispatchedAt: T0 }),
			job({ id: 'run2', state: 'QUEUED', dispatchedAt: T0 }),
			job({ id: 'a' }),
			job({ id: 'b' }),
		];
		const out = schedule({ now: T0, jobs, policy: policy({ concurrency: 3 }), bucket: unlimited });
		expect(ids(out.decisions, 'dispatch')).toEqual(['a']);
	});

	it('同時実行の上限に達していれば何も投入しない', () => {
		const jobs = [job({ id: 'run1', state: 'RUNNING', dispatchedAt: T0 }), job({ id: 'a' })];
		const out = schedule({ now: T0, jobs, policy: policy({ concurrency: 1 }), bucket: unlimited });
		expect(out.decisions).toEqual([]);
	});
});

describe('concurrencyKey単位の上限(ADR-0009)', () => {
	it('同一キーは上限までしか投入しない', () => {
		const jobs = [job({ id: 'a', concurrencyKey: 'cust-1' }), job({ id: 'b', concurrencyKey: 'cust-1' })];
		const out = schedule({ now: T0, jobs, policy: policy({ perKeyConcurrency: 1 }), bucket: unlimited });
		expect(ids(out.decisions, 'dispatch')).toEqual(['a']);
	});

	it('埋まったキーが他のキーを巻き添えにしない', () => {
		// 実装がcontinueではなくbreakしていると'c'が投入されず,
		// 1テナントが全体を止める事故になる
		const jobs = [
			job({ id: 'a', concurrencyKey: 'cust-1' }),
			job({ id: 'b', concurrencyKey: 'cust-1' }),
			job({ id: 'c', concurrencyKey: 'cust-2' }),
		];
		const out = schedule({ now: T0, jobs, policy: policy({ perKeyConcurrency: 1 }), bucket: unlimited });
		expect(ids(out.decisions, 'dispatch')).toEqual(['a', 'c']);
	});

	it('実行中のキーも数える', () => {
		const jobs = [
			job({ id: 'run', state: 'RUNNING', concurrencyKey: 'cust-1', dispatchedAt: T0 }),
			job({ id: 'a', concurrencyKey: 'cust-1' }),
		];
		const out = schedule({ now: T0, jobs, policy: policy({ perKeyConcurrency: 1 }), bucket: unlimited });
		expect(out.decisions).toEqual([]);
	});

	it('キーがnullのジョブには上限を適用しない', () => {
		const jobs = [job({ id: 'a' }), job({ id: 'b' }), job({ id: 'c' })];
		const out = schedule({ now: T0, jobs, policy: policy({ perKeyConcurrency: 1 }), bucket: unlimited });
		expect(ids(out.decisions, 'dispatch')).toEqual(['a', 'b', 'c']);
	});
});

describe('レート制限(ADR-0009)', () => {
	it('トークンが尽きたら止まる', () => {
		const jobs = [job({ id: 'a' }), job({ id: 'b' }), job({ id: 'c' })];
		const out = schedule({
			now: T0,
			jobs,
			policy: policy({ rate: { tokens: 60, intervalMs: 60_000 } }),
			bucket: { tokens: 2, refilledAt: T0 },
		});
		expect(ids(out.decisions, 'dispatch')).toEqual(['a', 'b']);
	});

	it('トークン切れならその回復時刻に起動する', () => {
		const out = schedule({
			now: T0,
			jobs: [job({ id: 'a' })],
			// 毎分60トークン= 1トークン/秒
			policy: policy({ rate: { tokens: 60, intervalMs: 60_000 } }),
			bucket: { tokens: 0, refilledAt: T0 },
		});
		expect(out.decisions).toEqual([]);
		expect(out.nextAlarmAt).toBe(T0 + 1_000);
	});

	it('経過時間ぶん補充される', () => {
		const out = schedule({
			now: T0 + 5_000,
			jobs: [job({ id: 'a', runAfter: T0 })],
			policy: policy({ rate: { tokens: 60, intervalMs: 60_000 } }),
			bucket: { tokens: 0, refilledAt: T0 },
		});
		// 5秒で5トークン回復し,1件消費して4
		expect(ids(out.decisions, 'dispatch')).toEqual(['a']);
		expect(out.bucket.tokens).toBeCloseTo(4, 5);
	});

	it('上限を超えて溜まらない', () => {
		const out = schedule({
			now: T0 + 3_600_000,
			jobs: [],
			policy: policy({ rate: { tokens: 60, intervalMs: 60_000 } }),
			bucket: { tokens: 0, refilledAt: T0 },
		});
		expect(out.bucket.tokens).toBe(60);
	});
});

describe('優先度とエージング(ADR-0019 / ADR-0020)', () => {
	it('優先度が高い順に投入する', () => {
		const jobs = [job({ id: 'low', priority: 0 }), job({ id: 'high', priority: 5 })];
		const out = schedule({ now: T0, jobs, policy: policy({ concurrency: 1 }), bucket: unlimited });
		expect(ids(out.decisions, 'dispatch')).toEqual(['high']);
	});

	it('エージング無効なら,どれだけ待っても低優先は追い越せない(飢餓が起きる)', () => {
		const jobs = [job({ id: 'old-low', priority: 0, createdAt: T0 - 3_600_000 }), job({ id: 'new-high', priority: 5, createdAt: T0 })];
		const out = schedule({ now: T0, jobs, policy: policy({ concurrency: 1, agingIntervalMs: null }), bucket: unlimited });
		expect(ids(out.decisions, 'dispatch')).toEqual(['new-high']);
	});

	it('エージング有効なら,十分待った低優先が高優先を追い越す', () => {
		const jobs = [
			// 10分待機,1分ごとに+1で実効優先度10
			job({ id: 'old-low', priority: 0, createdAt: T0 - 600_000 }),
			job({ id: 'new-high', priority: 5, createdAt: T0 }),
		];
		const out = schedule({
			now: T0,
			jobs,
			policy: policy({ concurrency: 1, agingIntervalMs: 60_000 }),
			bucket: unlimited,
		});
		expect(ids(out.decisions, 'dispatch')).toEqual(['old-low']);
	});

	it('追い越しの境界:まだ足りなければ追い越さない', () => {
		const jobs = [
			// 4分待機で実効優先度4 < 5
			job({ id: 'old-low', priority: 0, createdAt: T0 - 240_000 }),
			job({ id: 'new-high', priority: 5, createdAt: T0 }),
		];
		const out = schedule({
			now: T0,
			jobs,
			policy: policy({ concurrency: 1, agingIntervalMs: 60_000 }),
			bucket: unlimited,
		});
		expect(ids(out.decisions, 'dispatch')).toEqual(['new-high']);
	});
});

describe('reaper (ADR-0006 / ADR-0007 / ADR-0012)', () => {
	const dispatched = (over: Partial<JobView> & { id: string }) => job({ state: 'QUEUED', dispatchedAt: T0, timeoutMs: 60_000, ...over });

	it('無応答でなければ変更しない', () => {
		const out = schedule({
			now: T0 + 60_000 + 30_000 - 1,
			jobs: [dispatched({ id: 'a' })],
			policy: policy(),
			bucket: unlimited,
		});
		expect(out.decisions).toEqual([]);
	});

	it('timeout + graceを過ぎたat-least-onceは再投入する', () => {
		const out = schedule({
			now: T0 + 60_000 + 30_000,
			jobs: [dispatched({ id: 'a', attempts: 1 })],
			policy: policy(),
			bucket: unlimited,
		});
		expect(out.decisions).toContainEqual({ type: 'reap', id: 'a', attempts: 2 });
	});

	it('生存報告があれば期限が延びる', () => {
		// 所要時間が入力で変わるジョブに合わせてtimeoutMsを伸ばさずに済む
		const jobs = [dispatched({ id: 'a', heartbeatAt: T0 + 60_000 })];

		expect(schedule({ now: T0 + 120_000, jobs, policy: policy(), bucket: unlimited }).decisions).toEqual([]);
		expect(schedule({ now: T0 + 150_000, jobs, policy: policy(), bucket: unlimited }).decisions).toContainEqual({
			type: 'reap',
			id: 'a',
			attempts: 1,
		});
	});

	it('投入より前の生存報告では期限を縮めない', () => {
		// 再投入で報告が消えなかった場合でも, 判定が早まってはならない
		const out = schedule({
			now: T0 + 90_000 - 1,
			jobs: [dispatched({ id: 'a', heartbeatAt: T0 - 60_000 })],
			policy: policy(),
			bucket: unlimited,
		});
		expect(out.decisions).toEqual([]);
	});

	it('at-most-onceは再投入せずSTALLEDにする', () => {
		// Queues自体がat-least-onceなので,再投入すると二重実行になり得る
		const out = schedule({
			now: T0 + 90_000,
			jobs: [dispatched({ id: 'a', guarantee: 'at-most-once' })],
			policy: policy(),
			bucket: unlimited,
		});
		expect(out.decisions).toEqual([{ type: 'stall', id: 'a' }]);
	});

	it('試行回数を使い切っていればFAILEDにする', () => {
		const out = schedule({
			now: T0 + 90_000,
			jobs: [dispatched({ id: 'a', attempts: 3, maxAttempts: 3 })],
			policy: policy(),
			bucket: unlimited,
		});
		expect(out.decisions).toEqual([{ type: 'fail', id: 'a', reason: 'exhausted' }]);
	});

	it('回収で空いた分は,同じtickで他のジョブが使える', () => {
		// 応答しないジョブに上限を占有させ続ける方が害が大きい
		const jobs = [dispatched({ id: 'stuck' }), job({ id: 'waiting' })];
		const out = schedule({ now: T0 + 90_000, jobs, policy: policy({ concurrency: 1 }), bucket: unlimited });
		expect(ids(out.decisions, 'reap')).toEqual(['stuck']);
		expect(ids(out.decisions, 'dispatch')).toEqual(['waiting']);
	});

	it('回収したジョブ自身は同じtickで再投入せず,次のtickに送る', () => {
		const jobs = [dispatched({ id: 'stuck' })];
		const out = schedule({ now: T0 + 90_000, jobs, policy: policy({ concurrency: 10 }), bucket: unlimited });
		expect(ids(out.decisions, 'reap')).toEqual(['stuck']);
		expect(ids(out.decisions, 'dispatch')).toEqual([]);
		expect(out.nextAlarmAt).toBe(T0 + 90_000);
	});

	it('回収予定がなければ,次の無応答判定時刻に起動する', () => {
		const out = schedule({ now: T0, jobs: [dispatched({ id: 'a' })], policy: policy(), bucket: unlimited });
		expect(out.nextAlarmAt).toBe(T0 + 60_000 + 30_000);
	});

	it('RUNNING中に落ちたジョブが滞留しない', () => {
		// 待ち状態しか見ない実装ではisolateが落ちたジョブが永久に放置される
		const out = schedule({
			now: T0 + 10_000_000,
			jobs: [dispatched({ id: 'zombie', state: 'RUNNING' })],
			policy: policy(),
			bucket: unlimited,
		});
		expect(out.decisions.length).toBeGreaterThan(0);
	});
});

describe('nextAlarmAt', () => {
	it('投入したジョブの無応答判定時刻を含める', () => {
		// 入力のスナップショットでは投入対象はまだSCHEDULEDなので, nextSilenceには現れない
		// ここを取りこぼすと投入後にDOを起動する予定が立たず,応答が無いジョブが永久に回収されない
		const out = schedule({
			now: T0,
			jobs: [job({ id: 'a', timeoutMs: 60_000 })],
			policy: policy({ reaperGraceMs: 30_000 }),
			bucket: unlimited,
		});
		expect(ids(out.decisions, 'dispatch')).toEqual(['a']);
		expect(out.nextAlarmAt).toBe(T0 + 60_000 + 30_000);
	});

	it('やることが何も無ければnull', () => {
		const out = schedule({ now: T0, jobs: [], policy: policy(), bucket: unlimited });
		expect(out.nextAlarmAt).toBeNull();
	});

	it('複数の候補のうち最も早い時刻を選ぶ', () => {
		const jobs = [
			job({ id: 'later', runAfter: T0 + 100_000 }),
			job({ id: 'sooner', runAfter: T0 + 5_000 }),
			job({ id: 'inflight', state: 'QUEUED', dispatchedAt: T0, timeoutMs: 1_000 }),
		];
		const out = schedule({ now: T0, jobs, policy: policy({ reaperGraceMs: 30_000 }), bucket: unlimited });
		// 5秒後vs無応答判定31秒後-> 5秒後
		expect(out.nextAlarmAt).toBe(T0 + 5_000);
	});

	it('上限待ちでは予約しない(完了報告が次のtickを起動するため)', () => {
		const jobs = [job({ id: 'run', state: 'RUNNING', dispatchedAt: T0, timeoutMs: 10 ** 12 }), job({ id: 'wait' })];
		const out = schedule({ now: T0, jobs, policy: policy({ concurrency: 1, reaperGraceMs: 10 ** 12 }), bucket: unlimited });
		expect(ids(out.decisions, 'dispatch')).toEqual([]);
		expect(out.nextAlarmAt).toBe(T0 + 2 * 10 ** 12);
	});
});

describe('投入が止まった制約の報告(ADR-0009, #10)', () => {
	it('上限に達するとcapacity', () => {
		const out = schedule({ now: T0, jobs: [job({ id: 'a' }), job({ id: 'b' })], policy: policy({ concurrency: 1 }), bucket: unlimited });
		expect(ids(out.decisions, 'dispatch')).toEqual(['a']);
		expect(out.blocked).toEqual({ capacity: true, tokens: false, perKey: false });
	});

	it('トークンが足りないとtokens', () => {
		const out = schedule({
			now: T0,
			jobs: [job({ id: 'a' })],
			policy: policy({ rate: { tokens: 1, intervalMs: 1_000 } }),
			bucket: { tokens: 0, refilledAt: T0 },
		});
		expect(ids(out.decisions, 'dispatch')).toEqual([]);
		expect(out.blocked).toEqual({ capacity: false, tokens: true, perKey: false });
	});

	it('キー単位の上限で候補を飛ばすとperKey', () => {
		const jobs = [job({ id: 'a', concurrencyKey: 'k' }), job({ id: 'b', concurrencyKey: 'k' })];
		const out = schedule({ now: T0, jobs, policy: policy({ perKeyConcurrency: 1 }), bucket: unlimited });
		expect(ids(out.decisions, 'dispatch')).toEqual(['a']);
		expect(out.blocked).toEqual({ capacity: false, tokens: false, perKey: true });
	});

	it('自由に投入できるときは全てfalse', () => {
		const out = schedule({ now: T0, jobs: [job({ id: 'a' })], policy: policy(), bucket: unlimited });
		expect(out.blocked).toEqual({ capacity: false, tokens: false, perKey: false });
	});
});
