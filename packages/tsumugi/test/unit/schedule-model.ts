import type { ScheduleInput } from '../../src/core/types.js';

/**
 * schedule()のdispatch決定の参照モデル, 仕様の用語(同時実行数 / トークン / キー上限 / 優先度)のみで記述
 * 実装の写しでは実装と検査の誤りが相殺, 実装は非参照
 * reaperとnextAlarmAtは対象外
 */
export function expectedDispatchIds(input: ScheduleInput): string[] {
	const { now, jobs, policy } = input;

	const reaped = new Set(
		jobs
			.filter((j) => (j.state === 'QUEUED' || j.state === 'RUNNING') && j.dispatchedAt !== null)
			.filter(
				(j) =>
					now >= j.dispatchedAt! + j.timeoutMs + policy.reaperGraceMs ||
					(j.cancelRequestedAt !== null && now >= j.cancelRequestedAt + policy.reaperGraceMs),
			)
			.map((j) => j.id),
	);

	const inFlight = jobs.filter((j) => (j.state === 'QUEUED' || j.state === 'RUNNING') && !reaped.has(j.id));

	const keyInFlight = new Map<string, number>();
	for (const j of inFlight) {
		if (j.concurrencyKey !== null) keyInFlight.set(j.concurrencyKey, (keyInFlight.get(j.concurrencyKey) ?? 0) + 1);
	}

	const ready = jobs
		.filter((j) => j.state === 'SCHEDULED' && j.runAfter <= now && (j.expiresAt === null || now < j.expiresAt))
		.filter((j) => j.cancelRequestedAt === null)
		.map((j) => ({ job: j, ep: agedPriority(j.priority, j.createdAt, now, policy.agingIntervalMs) }))
		.sort((a, b) => b.ep - a.ep || a.job.createdAt - b.job.createdAt || (a.job.id < b.job.id ? -1 : 1));

	let slots = policy.paused ? 0 : Math.max(0, policy.concurrency - inFlight.length);
	let tokens = policy.rate === null ? Number.POSITIVE_INFINITY : refilledTokens(input);
	const keyTokens = new Map<string, number>();
	const keyTokensOf = (key: string): number => {
		if (policy.perKeyRate === null) return Number.POSITIVE_INFINITY;
		const known = keyTokens.get(key);
		if (known !== undefined) return known;
		const stored = input.keyBuckets?.[key];
		if (stored === undefined) return policy.perKeyRate.tokens;
		const elapsed = Math.max(0, now - stored.refilledAt);
		return Math.min(policy.perKeyRate.tokens, stored.tokens + elapsed * (policy.perKeyRate.tokens / policy.perKeyRate.intervalMs));
	};

	const dispatched: string[] = [];
	for (const { job } of ready) {
		if (slots <= 0) break;
		if (tokens < 1) break;
		const key = job.concurrencyKey;
		if (key !== null && (keyInFlight.get(key) ?? 0) >= policy.perKeyConcurrency) continue;
		if (key !== null && keyTokensOf(key) < 1) continue;

		dispatched.push(job.id);
		slots--;
		tokens--;
		if (key !== null) keyTokens.set(key, keyTokensOf(key) - 1);
		if (key !== null) keyInFlight.set(key, (keyInFlight.get(key) ?? 0) + 1);
	}
	return dispatched;
}

function agedPriority(priority: number, createdAt: number, now: number, agingIntervalMs: number | null): number {
	if (agingIntervalMs === null || agingIntervalMs <= 0) return priority;
	return priority + Math.floor(Math.max(0, now - createdAt) / agingIntervalMs);
}

// スケジューラのrefillと同式
function refilledTokens(input: ScheduleInput): number {
	const rate = input.policy.rate!;
	const elapsed = Math.max(0, input.now - input.bucket.refilledAt);
	return Math.min(rate.tokens, input.bucket.tokens + elapsed * (rate.tokens / rate.intervalMs));
}
