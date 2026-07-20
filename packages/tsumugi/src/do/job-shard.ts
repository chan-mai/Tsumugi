import { DurableObject } from 'cloudflare:workers';
import { createId } from '@paralleldrive/cuid2';
import { formatJobId } from '../core/ids.js';
import { nextAttempt } from '../core/backoff.js';
import { schedule } from '../core/schedule.js';
import type { Backoff, Bucket, DeliveryGuarantee, Policy } from '../core/types.js';
import { systemClock, type Clock } from './clock.js';
import { JobRepo } from './repo.js';

/** Queuesに載せるメッセージ,ペイロードはここに同梱してconsumerがDOを引かずに済むようにする */
export type DispatchMessage = {
	jobId: string;
	binding: string;
	attempt: number;
	payload: unknown;
	timeoutMs: number;
	/** at-most-onceのジョブは実行前にclaimを取る必要がある(ADR-0007) */
	claimRequired: boolean;
};

export type ShardEnv = {
	TSUMUGI_QUEUE: Queue<DispatchMessage>;
};

export type EnqueueInput = {
	binding: string;
	payload: unknown;
	priority?: number;
	maxAttempts?: number;
	concurrencyKey?: string;
	uniqueKey?: string;
	guarantee?: DeliveryGuarantee;
	timeoutMs?: number;
	backoff?: Backoff;
	delayMs?: number;
	runAt?: number;
};

export const DEFAULT_POLICY: Policy = {
	concurrency: 100,
	perKeyConcurrency: 1,
	rate: null,
	agingIntervalMs: 60_000,
	reaperGraceMs: 30_000,
};

const DEFAULTS: {
	priority: number;
	maxAttempts: number;
	timeoutMs: number;
	backoff: Backoff;
	guarantee: DeliveryGuarantee;
} = {
	priority: 0,
	maxAttempts: 3,
	timeoutMs: 60_000,
	backoff: { kind: 'exponential', baseMs: 1_000, factor: 2, maxMs: 3_600_000, jitter: true },
	guarantee: 'at-least-once',
};

/**
 * 1 tickで扱うジョブ数の上限
 * alarmのwall time上限は15分なので, tickは必ず有界にし残りは次のtickへ送る
 */
const TICK_LIMIT = 200;

/**
 * ジョブの調停役(ADR-0002)
 *
 * 判断は`core/schedule.ts`の純粋関数に委ね,ここはSQLiteとの橋渡しに徹する(ADR-0018)
 * 時刻は必ず`this.clock`経由で取る, `Date.now()`を直接呼ぶとテストできなくなる
 */
export class TsumugiJobShard extends DurableObject<ShardEnv> {
	/** テストから差し替えるためpublicにしている */
	clock: Clock = systemClock;
	policy: Policy = DEFAULT_POLICY;

	#repo: JobRepo | undefined;
	#bucket: Bucket = { tokens: Number.POSITIVE_INFINITY, refilledAt: 0 };

	get repo(): JobRepo {
		if (!this.#repo) this.#repo = new JobRepo(this.ctx.storage.sql);
		return this.#repo;
	}

	async enqueue(input: EnqueueInput): Promise<string> {
		const [id] = await this.enqueueMany([input]);
		return id as string;
	}

	/**
	 * まとめて投入する
	 * 個別RPCの逐次enqueueはDOの1,000 req/sソフト上限に律速され実測78件/秒しか出ない
	 * 上限を回避する唯一の手段なので,単発のenqueueもこれに委ねる
	 */
	async enqueueMany(inputs: readonly EnqueueInput[]): Promise<string[]> {
		const now = this.clock.now();
		const ids: string[] = [];

		for (const input of inputs) {
			const shard = 0;
			const id = formatJobId({ binding: input.binding, shard, localId: createId() });
			this.repo.insert({
				id,
				binding: input.binding,
				priority: input.priority ?? DEFAULTS.priority,
				maxAttempts: input.maxAttempts ?? DEFAULTS.maxAttempts,
				concurrencyKey: input.concurrencyKey ?? null,
				uniqueKey: input.uniqueKey ?? null,
				guarantee: input.guarantee ?? DEFAULTS.guarantee,
				timeoutMs: input.timeoutMs ?? DEFAULTS.timeoutMs,
				backoff: input.backoff ?? DEFAULTS.backoff,
				runAfter: input.runAt ?? now + (input.delayMs ?? 0),
				createdAt: now,
				payload: input.payload,
			});
			ids.push(id);
		}

		await this.#armAlarm(now);
		return ids;
	}

	/**
	 * consumerからの完了報告
	 * 失敗ならバックオフを計算してSCHEDULEDへ戻す,試行回数を使い切っていればFAILED
	 * リトライ方針をここが持つのでQueuesの`max_retries`に縛られない(ADR-0004)
	 */
	async report(jobId: string, result: { ok: boolean }): Promise<void> {
		const now = this.clock.now();

		if (result.ok) {
			this.repo.compareAndSet(jobId, ['QUEUED', 'RUNNING'], 'COMPLETED', { now });
			await this.#armAlarm(now);
			return;
		}

		const row = this.repo.find(jobId);
		if (!row) return;

		const attempts = row.attempts + 1;
		const next = nextAttempt({
			attempts,
			maxAttempts: row.max_attempts,
			backoff: JSON.parse(row.backoff) as Backoff,
			now,
			// 乱数はここで作ってcoreに渡す, coreは純粋に保つ(ADR-0018)
			rand: Math.random(),
		});

		if (next.kind === 'exhausted') {
			this.repo.compareAndSet(jobId, ['QUEUED', 'RUNNING'], 'FAILED', { now, attempts });
			await this.#armAlarm(now);
			return;
		}

		this.repo.compareAndSet(jobId, ['QUEUED', 'RUNNING'], 'SCHEDULED', {
			now,
			attempts,
			runAfter: next.runAfter,
			dispatchedAt: null,
		});
		await this.#armAlarm(next.runAfter);
	}

	/**
	 * at-most-onceのジョブの実行権
	 * Queues自体がat-least-onceなので重複配送が来る,単一SQLのrowsWritten判定で勝者を1本に絞る(ADR-0007)
	 */
	async claim(jobId: string): Promise<boolean> {
		return this.repo.compareAndSet(jobId, ['QUEUED'], 'RUNNING', { now: this.clock.now() });
	}

	/**
	 * 実行前のジョブの取り消し
	 * QUEUED以降はconsumerが既に実行を始めているかもしれず,取り消せたと嘘をつかない(ADR-0012)
	 */
	async cancel(jobId: string): Promise<boolean> {
		return this.repo.compareAndSet(jobId, ['SCHEDULED'], 'CANCELLED', { now: this.clock.now() });
	}

	async alarm(): Promise<void> {
		try {
			await this.#tick();
		} catch (error) {
			// alarm()がthrowするとworkerdは2秒起点の指数バックオフで最大6回しかリトライしない
			// 握って必ず次のalarmを張り直し,一時的な失敗で調停が止まらないようにする
			console.error('tsumugi: tick failed', error);
			await this.ctx.storage.setAlarm(this.clock.now() + 5_000);
		}
	}

	async #tick(): Promise<void> {
		const now = this.clock.now();
		const jobs = this.repo.activeJobs(TICK_LIMIT);
		const output = schedule({ now, jobs, policy: this.policy, bucket: this.#bucket });
		this.#bucket = output.bucket;

		const messages: MessageSendRequest<DispatchMessage>[] = [];
		for (const decision of output.decisions) {
			switch (decision.type) {
				case 'dispatch': {
					const row = this.repo.find(decision.id);
					if (!row) break;
					// 先に状態を進めてから投入する,投入に失敗してもQUEUEDのまま残りreaperが拾える
					if (!this.repo.compareAndSet(decision.id, ['SCHEDULED'], 'QUEUED', { now, dispatchedAt: now })) break;
					messages.push({
						body: {
							jobId: row.id,
							binding: row.binding,
							attempt: row.attempts + 1,
							payload: this.repo.payloadOf(row),
							timeoutMs: row.timeout_ms,
							claimRequired: row.guarantee === 'at-most-once',
						},
					});
					break;
				}
				case 'reap':
					this.repo.compareAndSet(decision.id, ['QUEUED', 'RUNNING'], 'SCHEDULED', {
						now,
						attempts: decision.attempts,
						dispatchedAt: null,
					});
					break;
				case 'stall':
					this.repo.compareAndSet(decision.id, ['QUEUED', 'RUNNING'], 'STALLED', { now });
					break;
				case 'fail':
					this.repo.compareAndSet(decision.id, ['QUEUED', 'RUNNING'], 'FAILED', { now });
					break;
			}
		}

		if (messages.length > 0) await this.env.TSUMUGI_QUEUE.sendBatch(messages);

		// 上限まで読んだなら残りがある可能性が高いので即座に自分を起こし直す
		const hasMore = jobs.length >= TICK_LIMIT;
		const next = hasMore ? now : output.nextAlarmAt;
		if (next !== null) await this.ctx.storage.setAlarm(next);
	}

	/** 予定より早い時刻にalarmが張られている場合は上書きしない */
	async #armAlarm(at: number): Promise<void> {
		const current = await this.ctx.storage.getAlarm();
		if (current === null || current > at) await this.ctx.storage.setAlarm(at);
	}
}
