import { effectivePriority } from '../../src/core/schedule.js';
import type { ScheduleInput } from '../../src/core/types.js';

/**
 * schedule()のdispatch決定を独立に再計算する参照モデル
 *
 * property testが実装のロジックをそのまま写すと, 実装がずれても検査が同じだけずれて相殺する
 * このモデルは仕様の言葉(枠 / トークン / キー上限 / 優先度)だけで書き, 実装を参照しない
 * reaperとnextAlarmAtは扱わない, dispatchの正しさに絞る
 */
export function expectedDispatchIds(input: ScheduleInput): string[] {
	const { now, jobs, policy } = input;

	// 回収されるジョブ(沈黙したQUEUED/RUNNING)は枠から外れる
	const reaped = new Set(
		jobs
			.filter((j) => (j.state === 'QUEUED' || j.state === 'RUNNING') && j.dispatchedAt !== null)
			.filter((j) => now >= j.dispatchedAt! + j.timeoutMs + policy.reaperGraceMs)
			.map((j) => j.id),
	);

	const inFlight = jobs.filter((j) => (j.state === 'QUEUED' || j.state === 'RUNNING') && !reaped.has(j.id));

	const keyInFlight = new Map<string, number>();
	for (const j of inFlight) {
		if (j.concurrencyKey !== null) keyInFlight.set(j.concurrencyKey, (keyInFlight.get(j.concurrencyKey) ?? 0) + 1);
	}

	const ready = jobs
		.filter((j) => j.state === 'SCHEDULED' && j.runAfter <= now)
		.map((j) => ({ job: j, ep: effectivePriority(j, now, policy.agingIntervalMs) }))
		.sort((a, b) => b.ep - a.ep || a.job.createdAt - b.job.createdAt || (a.job.id < b.job.id ? -1 : 1));

	let slots = Math.max(0, policy.concurrency - inFlight.length);
	// rate無しはトークン無限, 有りは補充後の残量から始める
	let tokens = policy.rate === null ? Number.POSITIVE_INFINITY : refilledTokens(input);

	const dispatched: string[] = [];
	for (const { job } of ready) {
		if (slots <= 0) break;
		if (tokens < 1) break;
		const key = job.concurrencyKey;
		if (key !== null && (keyInFlight.get(key) ?? 0) >= policy.perKeyConcurrency) continue;

		dispatched.push(job.id);
		slots--;
		tokens--;
		if (key !== null) keyInFlight.set(key, (keyInFlight.get(key) ?? 0) + 1);
	}
	return dispatched;
}

/** レート有効時の補充後トークン, スケジューラのrefillと同じ式 */
function refilledTokens(input: ScheduleInput): number {
	const rate = input.policy.rate!;
	const elapsed = Math.max(0, input.now - input.bucket.refilledAt);
	return Math.min(rate.tokens, input.bucket.tokens + elapsed * (rate.tokens / rate.intervalMs));
}
