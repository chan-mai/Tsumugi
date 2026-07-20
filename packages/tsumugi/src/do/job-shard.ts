import { DurableObject } from 'cloudflare:workers';
import { createId } from '@paralleldrive/cuid2';
import { formatJobId } from '../core/ids.js';
import { nextAttempt } from '../core/backoff.js';
import { schedule } from '../core/schedule.js';
import type { Backoff, Bucket, DeliveryGuarantee, Policy } from '../core/types.js';
import { systemClock, type Clock } from './clock.js';
import { writeMetrics } from '../analytics/writer.js';
import { project } from '../projection/projector.js';
import { JobRepo } from './repo.js';
import type { JobRow } from './schema.js';

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
	TSUMUGI_DB: D1Database;
	/** 任意,未設定ならメトリクスを書かない */
	TSUMUGI_METRICS?: AnalyticsEngineDataset;
};

/** DOに持たせる設定,流量制御と保持期間 */
export type ShardSettings = {
	policy?: Partial<Policy>;
	/** 終端に達したジョブをDOに残す時間 */
	sweepAfterMs?: number;
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
	/** uniqueKeyの予約を保持する期間,経過後は同じキーでも新規ジョブになる */
	uniqueForMs?: number;
	/** 分割している場合の投入先の決定に使う(ADR-0011) */
	partitionKey?: string;
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
	uniqueForMs: number;
} = {
	priority: 0,
	maxAttempts: 3,
	timeoutMs: 60_000,
	backoff: { kind: 'exponential', baseMs: 1_000, factor: 2, maxMs: 3_600_000, jitter: true },
	guarantee: 'at-least-once',
	uniqueForMs: 24 * 60 * 60 * 1_000,
};

/**
 * 1 tickで扱うジョブ数の上限
 * alarmのwall time上限は15分なので, tickは必ず有界にし残りは次のtickへ送る
 */
const TICK_LIMIT = 200;

/** 1回の投影で流すアウトボックスの上限, D1のバッチ上限とtickの時間を考えて抑える */
const PROJECTION_LIMIT = 200;

/** 1 tickで落とす終端ジョブの上限, tickを有界に保つ */
const SWEEP_LIMIT = 200;

/** 終端に達したジョブをDOに残す時間,投影が追いつく余裕を見て既定5分 */
const DEFAULT_SWEEP_AFTER_MS = 5 * 60 * 1000;

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
	sweepAfterMs: number = DEFAULT_SWEEP_AFTER_MS;

	#repo: JobRepo | undefined;
	#bucket: Bucket = { tokens: Number.POSITIVE_INFINITY, refilledAt: 0 };
	#policyLoaded = false;

	get repo(): JobRepo {
		if (!this.#repo) this.#repo = new JobRepo(this.ctx.storage.sql);
		return this.#repo;
	}

	/** 自分が何番のshardかは名前から読む,ルーティングの判断はworker側が持つ */
	get shardIndex(): number {
		const name = this.ctx.id.name;
		if (!name) return 0;
		const at = name.lastIndexOf('#');
		if (at < 0) return 0;
		const parsed = Number(name.slice(at + 1));
		return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
	}

	/** ポリシーはSQLiteに置く, tickが同期で読めるようにするため */
	#loadPolicy(): void {
		if (this.#policyLoaded) return;
		const raw = this.repo.readSetting('settings');
		if (raw) {
			const settings = JSON.parse(raw) as ShardSettings;
			this.policy = { ...DEFAULT_POLICY, ...settings.policy };
			this.sweepAfterMs = settings.sweepAfterMs ?? DEFAULT_SWEEP_AFTER_MS;
		}
		this.#policyLoaded = true;
	}

	async configure(settings: ShardSettings): Promise<void> {
		this.#applySettings(settings);
	}

	/** 内容が変わっていなければ書き込まない, enqueueのたびに1回増えるのを避ける */
	#applySettings(settings: ShardSettings): void {
		const encoded = JSON.stringify(settings);
		this.policy = { ...DEFAULT_POLICY, ...settings.policy };
		this.sweepAfterMs = settings.sweepAfterMs ?? DEFAULT_SWEEP_AFTER_MS;
		this.#policyLoaded = true;
		if (this.repo.readSetting('settings') === encoded) return;
		this.repo.writeSetting('settings', encoded);
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
	async enqueueMany(inputs: readonly EnqueueInput[], settings?: ShardSettings): Promise<string[]> {
		const now = this.clock.now();
		this.#loadPolicy();
		if (settings) this.#applySettings(settings);
		const ids: string[] = [];

		for (const input of inputs) {
			const id = formatJobId({ binding: input.binding, shard: this.shardIndex, localId: createId() });

			if (input.uniqueKey !== undefined) {
				const expiresAt = now + (input.uniqueForMs ?? DEFAULTS.uniqueForMs);
				const existing = this.repo.reserveUniqueKey(input.uniqueKey, id, expiresAt, now);
				// 衝突は正常系として扱い先行するジョブIDを返す, enqueueが冪等になる(ADR-0021)
				if (existing !== null) {
					ids.push(existing);
					continue;
				}
			}

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
			// 1回実行して成功したならattemptsは1,失敗時だけ数えると完了ジョブが0回に見える
			this.repo.compareAndSet(jobId, ['QUEUED', 'RUNNING'], 'COMPLETED', { now, countAttempt: true });
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
	 * ダッシュボードからの手動リトライ
	 * FAILEDとSTALLEDは終端だが不可逆ではない(ADR-0012)
	 */
	async retry(jobId: string): Promise<boolean> {
		const now = this.clock.now();
		const ok = this.repo.compareAndSet(jobId, ['FAILED', 'STALLED'], 'SCHEDULED', {
			now,
			runAfter: now,
			dispatchedAt: null,
		});
		if (ok) await this.#armAlarm(now);
		return ok;
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
		this.#loadPolicy();
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

		const projected = await this.#project();
		const { deleted, retryAt } = this.#sweep(now);

		// 上限まで読んだなら残りがある可能性が高いので即座に自分を起こし直す
		const hasMore = jobs.length >= TICK_LIMIT || projected >= PROJECTION_LIMIT || deleted >= SWEEP_LIMIT;
		const candidates = [hasMore ? now : output.nextAlarmAt, retryAt].filter((v): v is number => v !== null);
		const next = candidates.length > 0 ? Math.min(...candidates) : null;
		if (next !== null) await this.ctx.storage.setAlarm(next);
	}

	/**
	 * アウトボックスをD1へ流す(ADR-0008)
	 * D1への書き込みが成功してから削除するので,失敗すればカーソルは進まず次のtickで追いつく
	 */
	async #project(): Promise<number> {
		const rows = this.repo.outboxBatch(PROJECTION_LIMIT);
		if (rows.length === 0) return 0;
		await project(this.env.TSUMUGI_DB, rows);
		// 明細と同じ材料から時系列を書く, sweepで明細が消えてもこちらは残る(ADR-0016)
		writeMetrics(
			this.env.TSUMUGI_METRICS,
			rows.map((row) => JSON.parse(row.snapshot) as JobRow),
		);
		this.repo.deleteOutboxThrough(rows[rows.length - 1]!.seq);
		return rows.length;
	}

	/**
	 * 溜まったものを落とす
	 * 投影済みの終端ジョブと期限切れの重複排除キーを対象にする
	 */
	#sweep(now: number): { deleted: number; retryAt: number | null } {
		const before = now - this.sweepAfterMs;
		// 対象の有無を先に読む,状態をメモリに持つとDOのエビクトで掃除が止まる
		const sweepable = this.repo.hasSweepable(before, now);
		if (sweepable.uniqueKeys) this.repo.sweepExpiredUniqueKeys(now);
		const deleted = sweepable.jobs ? this.repo.sweepTerminal(before, SWEEP_LIMIT) : 0;

		// 終端ジョブを抱えている間は起き直す
		// 稼働中が無くなるとalarmが張られず,掃除する機会が永久に来ない
		// 消していなければ最初の読み取りの結果をそのまま使える
		const anyTerminal = deleted > 0 ? this.repo.hasSweepable(before, now).anyTerminal : sweepable.anyTerminal;
		return { deleted, retryAt: anyTerminal ? now + this.sweepAfterMs : null };
	}

	/** 予定より早い時刻にalarmが張られている場合は上書きしない */
	async #armAlarm(at: number): Promise<void> {
		const current = await this.ctx.storage.getAlarm();
		if (current === null || current > at) await this.ctx.storage.setAlarm(at);
	}
}
