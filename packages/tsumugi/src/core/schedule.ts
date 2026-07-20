import type { Bucket, Decision, JobView, Policy, ScheduleInput, ScheduleOutput } from './types.js';

/** エージング込みの実効優先度, ADR-0020 */
export function effectivePriority(job: JobView, now: number, agingIntervalMs: number | null): number {
	if (agingIntervalMs === null || agingIntervalMs <= 0) return job.priority;
	return job.priority + Math.floor(Math.max(0, now - job.createdAt) / agingIntervalMs);
}

/** 沈黙とみなす判定の期限 */
function silenceDeadline(job: JobView, policy: Policy): number | null {
	if (job.dispatchedAt === null) return null;
	return job.dispatchedAt + job.timeoutMs + policy.reaperGraceMs;
}

function refill(bucket: Bucket, policy: Policy, now: number): Bucket {
	if (policy.rate === null) return { tokens: Number.POSITIVE_INFINITY, refilledAt: now };
	const elapsed = Math.max(0, now - bucket.refilledAt);
	const perMs = policy.rate.tokens / policy.rate.intervalMs;
	const tokens = Math.min(policy.rate.tokens, bucket.tokens + elapsed * perMs);
	return { tokens, refilledAt: now };
}

/** トークンが1に達する時刻,既に足りていればnull */
function tokenReadyAt(bucket: Bucket, policy: Policy, now: number): number | null {
	if (policy.rate === null || bucket.tokens >= 1) return null;
	const perMs = policy.rate.tokens / policy.rate.intervalMs;
	if (perMs <= 0) return null;
	return now + Math.ceil((1 - bucket.tokens) / perMs);
}

const minOf = (values: readonly (number | null)[]): number | null =>
	values.reduce<number | null>((acc, v) => (v === null ? acc : acc === null ? v : Math.min(acc, v)), null);

/**
 * スケジューラの中核, ADR-0018によりDOから切り離した純粋関数
 * 時刻を引数で受けるのでalarm発火やreaper境界を時間操作なしでテスト可能
 *
 * 回収したジョブ自身は同じtickで再投入せずnextAlarmAtをnowにして次のtickへ送る(回収と投入の混在は推論が難しい)
 * ただし空いた枠は他のジョブが同じtickで使える,固着したジョブに枠を占有させ続ける方が害が大きいため
 *
 * 前提:回収は「沈黙したので諦めた」であってゾンビが走っている可能性は残る
 * 枠を空ける以上ゾンビの存在下で同時実行上限は厳密でなくなるが,死と遅延は原理的に区別できず回避不能
 */
export function schedule(input: ScheduleInput): ScheduleOutput {
	const { now, jobs, policy } = input;
	const decisions: Decision[] = [];
	let bucket = refill(input.bucket, policy, now);

	// 1. reaper:投入したまま沈黙しているジョブの回収
	const reaped = new Set<string>();
	for (const job of jobs) {
		if (job.state !== 'QUEUED' && job.state !== 'RUNNING') continue;
		const deadline = silenceDeadline(job, policy);
		if (deadline === null || now < deadline) continue;

		reaped.add(job.id);
		if (job.guarantee === 'at-most-once') {
			// ADR-0006 / ADR-0007,再投入は二重実行になり得るので人手に委ねる
			decisions.push({ type: 'stall', id: job.id });
		} else if (job.attempts >= job.maxAttempts) {
			decisions.push({ type: 'fail', id: job.id, reason: 'exhausted' });
		} else {
			decisions.push({ type: 'reap', id: job.id, attempts: job.attempts + 1 });
		}
	}

	// 2.実行中の在庫を数える,回収した分は枠を空ける
	const keyInFlight = new Map<string, number>();
	let inFlight = 0;
	for (const job of jobs) {
		if (job.state !== 'QUEUED' && job.state !== 'RUNNING') continue;
		if (reaped.has(job.id)) continue;
		inFlight++;
		if (job.concurrencyKey !== null) keyInFlight.set(job.concurrencyKey, (keyInFlight.get(job.concurrencyKey) ?? 0) + 1);
	}

	// 3.実行可能な候補を実効優先度順に並べる
	const ready = jobs
		.filter((j) => j.state === 'SCHEDULED' && j.runAfter <= now)
		.map((j) => ({ job: j, ep: effectivePriority(j, now, policy.agingIntervalMs) }))
		.sort((a, b) => b.ep - a.ep || a.job.createdAt - b.job.createdAt || (a.job.id < b.job.id ? -1 : 1));

	// 4.枠・トークン・キー単位上限を見ながら貪欲に投入
	let slots = Math.max(0, policy.concurrency - inFlight);
	let blockedByCapacity = false;
	let blockedByTokens = false;
	let dispatchedSilence: number | null = null;

	for (const { job } of ready) {
		if (slots <= 0) {
			blockedByCapacity = true;
			break;
		}
		if (bucket.tokens < 1) {
			blockedByTokens = true;
			break;
		}
		const key = job.concurrencyKey;
		// キー単位で埋まっているジョブは飛ばす, breakすると後続の別キーが巻き添えになる
		if (key !== null && (keyInFlight.get(key) ?? 0) >= policy.perKeyConcurrency) continue;

		decisions.push({ type: 'dispatch', id: job.id });
		slots--;
		bucket = { tokens: bucket.tokens - 1, refilledAt: bucket.refilledAt };
		if (key !== null) keyInFlight.set(key, (keyInFlight.get(key) ?? 0) + 1);
		// 今まさに投入したジョブの沈黙判定時刻,入力のスナップショットではまだSCHEDULEDなので個別に数える
		// これを忘れると投入後にDOを起こす予定が立たず,沈黙したジョブが永久に回収されない
		const deadline = now + job.timeoutMs + policy.reaperGraceMs;
		if (dispatchedSilence === null || deadline < dispatchedSilence) dispatchedSilence = deadline;
	}

	// 5.次に起きるべき時刻
	const futureRunAfter = minOf(jobs.filter((j) => j.state === 'SCHEDULED' && j.runAfter > now).map((j) => j.runAfter));
	const nextSilence = minOf(
		jobs.filter((j) => (j.state === 'QUEUED' || j.state === 'RUNNING') && !reaped.has(j.id)).map((j) => silenceDeadline(j, policy)),
	);
	const nextAlarmAt = minOf([
		reaped.size > 0 ? now : null,
		futureRunAfter,
		nextSilence,
		dispatchedSilence,
		blockedByTokens ? tokenReadyAt(bucket, policy, now) : null,
		// 枠待ちは完了報告が次のtickを起こすのでここでは予約しない
		blockedByCapacity ? null : null,
	]);

	return { decisions, bucket, nextAlarmAt };
}
