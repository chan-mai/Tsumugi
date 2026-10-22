import type { Bucket, Decision, JobView, KeyBuckets, Policy, RateLimit, ScheduleInput, ScheduleOutput } from './types.js';

export function effectivePriority(job: JobView, now: number, agingIntervalMs: number | null): number {
	if (agingIntervalMs === null || agingIntervalMs <= 0) return job.priority;
	return job.priority + Math.floor(Math.max(0, now - job.createdAt) / agingIntervalMs);
}

// heartbeat起点, 所要時間可変ジョブのtimeoutMs延長不要
function silenceDeadline(job: JobView, policy: Policy): number | null {
	if (job.dispatchedAt === null) return null;
	const since = job.heartbeatAt === null ? job.dispatchedAt : Math.max(job.dispatchedAt, job.heartbeatAt);
	return since + job.timeoutMs + policy.reaperGraceMs;
}

// 無応答判定より先に到来し得る(#95)
function cancelDeadline(job: JobView, policy: Policy): number | null {
	if (job.cancelRequestedAt === null) return null;
	return job.cancelRequestedAt + policy.reaperGraceMs;
}

function refill(bucket: Bucket, rate: RateLimit | null, now: number): Bucket {
	if (rate === null) return { tokens: Number.POSITIVE_INFINITY, refilledAt: now };
	const elapsed = Math.max(0, now - bucket.refilledAt);
	const perMs = rate.tokens / rate.intervalMs;
	const tokens = Math.min(rate.tokens, bucket.tokens + elapsed * perMs);
	return { tokens, refilledAt: now };
}

function tokenReadyAt(bucket: Bucket, rate: RateLimit | null, now: number): number | null {
	if (rate === null || bucket.tokens >= 1) return null;
	const perMs = rate.tokens / rate.intervalMs;
	if (perMs <= 0) return null;
	return now + Math.ceil((1 - bucket.tokens) / perMs);
}

const minOf = (values: readonly (number | null)[]): number | null =>
	values.reduce<number | null>((acc, v) => (v === null ? acc : acc === null ? v : Math.min(acc, v)), null);

/**
 * 回収ジョブの再投入は次tick, 同tick内の回収と投入の混在回避
 * 回収で空いた枠は同tickで他ジョブへ割当, 無応答ジョブの枠占有防止
 * 回収後も実行継続の可能性あり, 停止と遅延が区別不能で同時実行上限は非厳密
 */
export function schedule(input: ScheduleInput): ScheduleOutput {
	const { now, jobs, policy } = input;
	const decisions: Decision[] = [];
	let bucket = refill(input.bucket, policy.rate, now);

	const perKeyRate = policy.perKeyRate;
	const keyBuckets = new Map<string, Bucket>();
	if (perKeyRate !== null) {
		for (const [key, stored] of Object.entries(input.keyBuckets ?? {})) keyBuckets.set(key, refill(stored, perKeyRate, now));
	}
	const keyBucketOf = (key: string, rate: RateLimit): Bucket => {
		const existing = keyBuckets.get(key);
		if (existing !== undefined) return existing;
		const created = { tokens: rate.tokens, refilledAt: now };
		keyBuckets.set(key, created);
		return created;
	};

	const reaped = new Set<string>();
	for (const job of jobs) {
		if (job.state !== 'QUEUED' && job.state !== 'RUNNING') continue;
		const deadline = minOf([silenceDeadline(job, policy), cancelDeadline(job, policy)]);
		if (deadline === null || now < deadline) continue;

		reaped.add(job.id);
		if (job.expiresAt !== null && now >= job.expiresAt) {
			// 期限切れは回収せず終了, consumer報告失敗時の回復経路(ADR-0047)
			decisions.push({ type: 'expire', id: job.id });
		} else if (job.cancelRequestedAt !== null) {
			// 回収せず終了, 再投入と人手判断待ちは要求意図と不一致(#95)
			decisions.push({ type: 'cancel', id: job.id });
		} else if (job.guarantee === 'at-most-once') {
			// 二重実行の恐れある再投入は人手判断(ADR-0006, ADR-0007)
			decisions.push({ type: 'stall', id: job.id });
		} else if (job.attempts >= job.maxAttempts) {
			decisions.push({ type: 'fail', id: job.id, reason: 'exhausted' });
		} else {
			decisions.push({ type: 'reap', id: job.id, attempts: job.attempts + 1 });
		}
	}

	// 取り消し要求済みSCHEDULEDは回収競合の残留(#95)
	const expired = new Set<string>();
	for (const job of jobs) {
		if (job.state !== 'SCHEDULED' || job.runAfter > now) continue;
		if (job.expiresAt !== null && now >= job.expiresAt) {
			expired.add(job.id);
			decisions.push({ type: 'expire', id: job.id });
			continue;
		}
		if (job.cancelRequestedAt === null) continue;
		expired.add(job.id);
		decisions.push({ type: 'cancel', id: job.id });
	}

	const keyInFlight = new Map<string, number>();
	let inFlight = 0;
	for (const job of jobs) {
		if (job.state !== 'QUEUED' && job.state !== 'RUNNING') continue;
		if (reaped.has(job.id)) continue;
		inFlight++;
		if (job.concurrencyKey !== null) keyInFlight.set(job.concurrencyKey, (keyInFlight.get(job.concurrencyKey) ?? 0) + 1);
	}

	const ready = jobs
		.filter((j) => j.state === 'SCHEDULED' && j.runAfter <= now && !expired.has(j.id))
		.map((j) => ({ job: j, ep: effectivePriority(j, now, policy.agingIntervalMs) }))
		.sort((a, b) => b.ep - a.ep || a.job.createdAt - b.job.createdAt || (a.job.id < b.job.id ? -1 : 1));

	// 一時停止中も回収とエージング継続, 再開後も順序維持(#27)
	let slots = policy.paused ? 0 : Math.max(0, policy.concurrency - inFlight);
	let blockedByCapacity = false;
	let blockedByTokens = false;
	let blockedByKey = false;
	let blockedByKeyTokens = false;
	let keyTokenReady: number | null = null;
	let dispatchedSilence: number | null = null;

	for (const { job } of ready) {
		if (slots <= 0) {
			// 停止と容量不足を区別, 画面での緩和対象判別用
			if (!policy.paused) blockedByCapacity = true;
			break;
		}
		if (bucket.tokens < 1) {
			blockedByTokens = true;
			break;
		}
		const key = job.concurrencyKey;
		// キー上限到達は除外のみ, breakでは後続の別キーも投入不能
		if (key !== null && (keyInFlight.get(key) ?? 0) >= policy.perKeyConcurrency) {
			blockedByKey = true;
			continue;
		}
		// キートークン不足も除外のみ, 他キーとキーがnullのジョブは投入継続
		const keyBucket = key === null || perKeyRate === null ? null : keyBucketOf(key, perKeyRate);
		if (keyBucket !== null && keyBucket.tokens < 1) {
			blockedByKeyTokens = true;
			// 以後バケット不変, 回復時刻をここで確定
			keyTokenReady = minOf([keyTokenReady, tokenReadyAt(keyBucket, perKeyRate, now)]);
			continue;
		}

		decisions.push({ type: 'dispatch', id: job.id });
		slots--;
		bucket = { tokens: bucket.tokens - 1, refilledAt: bucket.refilledAt };
		if (keyBucket !== null) keyBucket.tokens -= 1;
		if (key !== null) keyInFlight.set(key, (keyInFlight.get(key) ?? 0) + 1);
		// 投入ジョブの無応答判定時刻, 入力上はSCHEDULEDで個別集計
		// 欠落時は投入後のalarm未設定で無応答ジョブが永久に未回収
		const deadline = now + job.timeoutMs + policy.reaperGraceMs;
		if (dispatchedSilence === null || deadline < dispatchedSilence) dispatchedSilence = deadline;
	}

	const futureRunAfter = minOf(jobs.filter((j) => j.state === 'SCHEDULED' && j.runAfter > now).map((j) => j.runAfter));
	const nextSilence = minOf(
		jobs
			.filter((j) => (j.state === 'QUEUED' || j.state === 'RUNNING') && !reaped.has(j.id))
			.map((j) => minOf([silenceDeadline(j, policy), cancelDeadline(j, policy)])),
	);
	const nextAlarmAt = minOf([
		reaped.size > 0 ? now : null,
		futureRunAfter,
		nextSilence,
		dispatchedSilence,
		blockedByTokens ? tokenReadyAt(bucket, policy.rate, now) : null,
		keyTokenReady,
		// 容量待ちは完了報告時に次tick起動, alarm不要
	]);

	// 出力に無いキーは保存側で削除
	const outKeyBuckets: KeyBuckets =
		perKeyRate === null ? {} : Object.fromEntries([...keyBuckets].filter(([, b]) => b.tokens < perKeyRate.tokens));

	return {
		decisions,
		bucket,
		keyBuckets: outKeyBuckets,
		nextAlarmAt,
		blocked: {
			paused: policy.paused && ready.length > 0,
			capacity: blockedByCapacity,
			tokens: blockedByTokens,
			perKey: blockedByKey,
			perKeyTokens: blockedByKeyTokens,
		},
	};
}
