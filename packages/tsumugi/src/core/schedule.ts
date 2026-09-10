import type { Bucket, Decision, JobView, KeyBuckets, Policy, RateLimit, ScheduleInput, ScheduleOutput } from './types.js';

/** エージング込みの実効優先度, ADR-0020 */
export function effectivePriority(job: JobView, now: number, agingIntervalMs: number | null): number {
	if (agingIntervalMs === null || agingIntervalMs <= 0) return job.priority;
	return job.priority + Math.floor(Math.max(0, now - job.createdAt) / agingIntervalMs);
}

/**
 * 無応答とみなす判定の期限
 * 生存報告があればそこが起点, 所要時間が入力で変わるジョブに合わせたtimeoutMsの延長が不要
 */
function silenceDeadline(job: JobView, policy: Policy): number | null {
	if (job.dispatchedAt === null) return null;
	const since = job.heartbeatAt === null ? job.dispatchedAt : Math.max(job.dispatchedAt, job.heartbeatAt);
	return since + job.timeoutMs + policy.reaperGraceMs;
}

function refill(bucket: Bucket, rate: RateLimit | null, now: number): Bucket {
	if (rate === null) return { tokens: Number.POSITIVE_INFINITY, refilledAt: now };
	const elapsed = Math.max(0, now - bucket.refilledAt);
	const perMs = rate.tokens / rate.intervalMs;
	const tokens = Math.min(rate.tokens, bucket.tokens + elapsed * perMs);
	return { tokens, refilledAt: now };
}

/** トークンが1に達する時刻,既に足りていればnull */
function tokenReadyAt(bucket: Bucket, rate: RateLimit | null, now: number): number | null {
	if (rate === null || bucket.tokens >= 1) return null;
	const perMs = rate.tokens / rate.intervalMs;
	if (perMs <= 0) return null;
	return now + Math.ceil((1 - bucket.tokens) / perMs);
}

const minOf = (values: readonly (number | null)[]): number | null =>
	values.reduce<number | null>((acc, v) => (v === null ? acc : acc === null ? v : Math.min(acc, v)), null);

/**
 * スケジューラの中核, ADR-0018によりDOから分離した純粋関数
 * 時刻を引数で受け、alarm発火やreaper境界を時間操作なしでテスト可能
 *
 * 回収したジョブ自身は同じtickで再投入せずnextAlarmAtをnowにして次のtickへ送る(回収と投入の混在は推論が難しい)
 * ただし空いた分は他のジョブが同じtickで利用可能, 応答しないジョブによる上限の占有継続の方が有害
 *
 * 前提:回収は無応答による中断であり、実行が継続している可能性は残る
 * 空きを作る以上、実行が継続している場合の同時実行上限は厳密ではなくなるが、停止と遅延は原理的に区別できず回避も不可能
 */
export function schedule(input: ScheduleInput): ScheduleOutput {
	const { now, jobs, policy } = input;
	const decisions: Decision[] = [];
	let bucket = refill(input.bucket, policy.rate, now);

	// キー別バケット(ADR-0045),入力の全キーをrefillし上限到達キーは出力の正規化で除外
	const perKeyRate = policy.perKeyRate;
	const keyBuckets = new Map<string, Bucket>();
	if (perKeyRate !== null) {
		for (const [key, stored] of Object.entries(input.keyBuckets ?? {})) keyBuckets.set(key, refill(stored, perKeyRate, now));
	}
	// readyに現れた未知キーはtokens上限から開始
	const keyBucketOf = (key: string, rate: RateLimit): Bucket => {
		const existing = keyBuckets.get(key);
		if (existing !== undefined) return existing;
		const created = { tokens: rate.tokens, refilledAt: now };
		keyBuckets.set(key, created);
		return created;
	};

	// 1. reaper:投入後に応答が無いジョブの回収
	const reaped = new Set<string>();
	for (const job of jobs) {
		if (job.state !== 'QUEUED' && job.state !== 'RUNNING') continue;
		const deadline = silenceDeadline(job, policy);
		if (deadline === null || now < deadline) continue;

		reaped.add(job.id);
		if (job.expiresAt !== null && now >= job.expiresAt) {
			// 期限切れの無応答ジョブは回収せず終了, consumerの報告が失敗した場合の回復経路(ADR-0047)
			decisions.push({ type: 'expire', id: job.id });
		} else if (job.guarantee === 'at-most-once') {
			// ADR-0006 / ADR-0007, 二重実行になり得る再投入は人手で判断
			decisions.push({ type: 'stall', id: job.id });
		} else if (job.attempts >= job.maxAttempts) {
			decisions.push({ type: 'fail', id: job.id, reason: 'exhausted' });
		} else {
			decisions.push({ type: 'reap', id: job.id, attempts: job.attempts + 1 });
		}
	}

	// 1.5期限切れ: 実行可能になったが期限を過ぎたSCHEDULEDは投入せず終了
	// 判定は投入候補に限定, 未到来のジョブはrunAfter到来時のtickで判定
	const expired = new Set<string>();
	for (const job of jobs) {
		if (job.state !== 'SCHEDULED' || job.runAfter > now) continue;
		if (job.expiresAt === null || now < job.expiresAt) continue;
		expired.add(job.id);
		decisions.push({ type: 'expire', id: job.id });
	}

	// 2.実行中の件数の集計, 回収した分は空きの扱い
	const keyInFlight = new Map<string, number>();
	let inFlight = 0;
	for (const job of jobs) {
		if (job.state !== 'QUEUED' && job.state !== 'RUNNING') continue;
		if (reaped.has(job.id)) continue;
		inFlight++;
		if (job.concurrencyKey !== null) keyInFlight.set(job.concurrencyKey, (keyInFlight.get(job.concurrencyKey) ?? 0) + 1);
	}

	// 3.実行可能な候補を実効優先度順に整列
	const ready = jobs
		.filter((j) => j.state === 'SCHEDULED' && j.runAfter <= now && !expired.has(j.id))
		.map((j) => ({ job: j, ep: effectivePriority(j, now, policy.agingIntervalMs) }))
		.sort((a, b) => b.ep - a.ep || a.job.createdAt - b.job.createdAt || (a.job.id < b.job.id ? -1 : 1));

	// 4.同時実行数・トークン・キー単位上限を確認しながら貪欲に投入
	// 一時停止中は投入なし, 回収とエージングは継続し再開後も順序を維持(#27)
	let slots = policy.paused ? 0 : Math.max(0, policy.concurrency - inFlight);
	let blockedByCapacity = false;
	let blockedByTokens = false;
	let blockedByKey = false;
	let blockedByKeyTokens = false;
	let keyTokenReady: number | null = null;
	let dispatchedSilence: number | null = null;

	for (const { job } of ready) {
		if (slots <= 0) {
			// 停止と容量不足は原因が別, 画面で緩和対象を判別できるよう区別
			if (!policy.paused) blockedByCapacity = true;
			break;
		}
		if (bucket.tokens < 1) {
			blockedByTokens = true;
			break;
		}
		const key = job.concurrencyKey;
		// キー単位で上限に達したジョブは除外のみ, breakすると後続の別キーも投入不能
		if (key !== null && (keyInFlight.get(key) ?? 0) >= policy.perKeyConcurrency) {
			blockedByKey = true;
			continue;
		}
		// キーのトークン不足は候補の除外のみ, 他のキーとキーがnullのジョブは投入
		const keyBucket = key === null || perKeyRate === null ? null : keyBucketOf(key, perKeyRate);
		if (keyBucket !== null && keyBucket.tokens < 1) {
			blockedByKeyTokens = true;
			// スキップ後のバケットは不変, 回復時刻はここで確定
			keyTokenReady = minOf([keyTokenReady, tokenReadyAt(keyBucket, perKeyRate, now)]);
			continue;
		}

		decisions.push({ type: 'dispatch', id: job.id });
		slots--;
		bucket = { tokens: bucket.tokens - 1, refilledAt: bucket.refilledAt };
		if (keyBucket !== null) keyBucket.tokens -= 1;
		if (key !== null) keyInFlight.set(key, (keyInFlight.get(key) ?? 0) + 1);
		// 今投入したジョブの無応答判定時刻, 入力のスナップショットではまだSCHEDULEDで個別に集計
		// これが無いと投入後のDO起動の予定が立たず、応答が無いジョブは永久に未回収
		const deadline = now + job.timeoutMs + policy.reaperGraceMs;
		if (dispatchedSilence === null || deadline < dispatchedSilence) dispatchedSilence = deadline;
	}

	// 5.次に起動すべき時刻
	const futureRunAfter = minOf(jobs.filter((j) => j.state === 'SCHEDULED' && j.runAfter > now).map((j) => j.runAfter));
	const nextSilence = minOf(
		jobs.filter((j) => (j.state === 'QUEUED' || j.state === 'RUNNING') && !reaped.has(j.id)).map((j) => silenceDeadline(j, policy)),
	);
	const nextAlarmAt = minOf([
		reaped.size > 0 ? now : null,
		futureRunAfter,
		nextSilence,
		dispatchedSilence,
		blockedByTokens ? tokenReadyAt(bucket, policy.rate, now) : null,
		keyTokenReady,
		// 上限待ちは完了報告が次のtickを起動, ここでの予約は不要(capacityのalarmは設定なし)
	]);

	// 上限到達キーは出力から除外,入力にあり出力に無いキーが保存側の削除対象
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
