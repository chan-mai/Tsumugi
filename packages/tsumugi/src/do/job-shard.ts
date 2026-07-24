import { DurableObject } from 'cloudflare:workers';
import { createId } from '@paralleldrive/cuid2';
import { formatJobId } from '../core/ids.js';
import { nextAttempt } from '../core/backoff.js';
import { schedule } from '../core/schedule.js';
import type { Backoff, Bucket, DeliveryGuarantee, Policy, Retention } from '../core/types.js';
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

/**
 * retry / cancelの結果
 * `gone`は保持期間を過ぎてDOから消えた状態, 一覧はD1から引くので画面には残り続ける(ADR-0027)
 */
export type MutationResult = { ok: true } | { ok: false; reason: 'invalid-state' | 'gone' };

/** DOに持たせる設定,流量制御と保持期間 */
export type ShardSettings = {
	policy?: Partial<Policy>;
	/** 済んだジョブ(COMPLETED / CANCELLED)をDOに残す時間, 既定5分 */
	sweepAfterMs?: number;
	/**
	 * 失敗ジョブ(FAILED / STALLED)をDOに残す時間, 既定7日
	 * 手動リトライの窓そのもの, 短くすると一覧に見えるのに再開できないジョブが出る(ADR-0027)
	 */
	failedRetentionMs?: number;
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

/** Cloudflare Queuesのプロデューサ側上限, 1回のsendBatchは100件まで, TICK_LIMITはこれを超えるので分割する */
const SEND_BATCH_LIMIT = 100;

/** 1 tickで落とす終端ジョブの上限, tickを有界に保つ */
const SWEEP_LIMIT = 200;

/** 済んだジョブをDOに残す時間,投影が追いつく余裕を見て既定5分 */
const DEFAULT_SWEEP_AFTER_MS = 5 * 60 * 1000;

/**
 * 失敗ジョブをDOに残す時間, 既定7日
 * D1の読み取りモデルの既定と揃える, 揃えないと一覧に見えるのに再開できないジョブが出る(ADR-0027)
 */
export const DEFAULT_FAILED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function retentionOf(settings: ShardSettings): Retention {
	return {
		doneMs: settings.sweepAfterMs ?? DEFAULT_SWEEP_AFTER_MS,
		failedMs: settings.failedRetentionMs ?? DEFAULT_FAILED_RETENTION_MS,
	};
}

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
	retention: Retention = { doneMs: DEFAULT_SWEEP_AFTER_MS, failedMs: DEFAULT_FAILED_RETENTION_MS };

	#repo: JobRepo | undefined;
	#bucket: Bucket = { tokens: Number.POSITIVE_INFINITY, refilledAt: 0 };
	#policyLoaded = false;

	get repo(): JobRepo {
		if (!this.#repo) this.#repo = new JobRepo(this.ctx.storage);
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
			this.retention = retentionOf(settings);
		}
		this.#policyLoaded = true;
	}

	async configure(settings: ShardSettings): Promise<void> {
		// configure()は実行時の意思, 静的設定より優先する印を付ける(#6)
		this.#applySettings(settings, true);
	}

	/**
	 * 設定を反映する, 内容が変わっていなければ書き込まない(enqueueのたびに1回増えるのを避ける)
	 * pinnedはconfigure()由来か, enqueue同梱の静的設定か
	 * 一度configure()されたら以降の静的設定は無視する, 実行時に絞った流量が次の投入で戻らないようにする(#6)
	 * 静的設定へ戻すには再度configure()する
	 */
	#applySettings(settings: ShardSettings, pinned: boolean): void {
		if (!pinned && this.repo.readSetting('settings_pinned') === '1') return;
		const encoded = JSON.stringify(settings);
		this.policy = { ...DEFAULT_POLICY, ...settings.policy };
		this.retention = retentionOf(settings);
		this.#policyLoaded = true;
		if (pinned && this.repo.readSetting('settings_pinned') !== '1') this.repo.writeSetting('settings_pinned', '1');
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
		// enqueue同梱は静的設定, configure()でpinされていれば無視する(#6)
		if (settings) this.#applySettings(settings, false);
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
	async report(jobId: string, result: { ok: boolean; error?: string }): Promise<void> {
		const now = this.clock.now();
		const row = this.repo.find(jobId);
		// 報告を受け付けられる状態かをここで見る
		// compareAndSetに任せると記録が遷移の後になり,アウトボックスに履歴が載らない(ADR-0028)
		if (!row || (row.state !== 'QUEUED' && row.state !== 'RUNNING')) return;

		const attempts = row.attempts + 1;
		// 1回目で成功したジョブの履歴はジョブ行から導出できるので書かない
		// 導出できないのは失敗の理由と試行ごとの時刻だけ, 常時書くと1ジョブあたりの書き込みが1回増える
		const worthRecording = !result.ok || attempts > 1;
		// 遷移でdispatched_atが消えるので開始時刻は先に確保する
		if (worthRecording)
			this.#recordAttempt(
				jobId,
				attempts,
				result.ok ? 'COMPLETED' : 'FAILED',
				row.dispatched_at,
				now,
				result.ok ? null : (result.error ?? null),
			);

		if (result.ok) {
			// 1回実行して成功したならattemptsは1,失敗時だけ数えると完了ジョブが0回に見える
			this.repo.compareAndSet(jobId, ['QUEUED', 'RUNNING'], 'COMPLETED', { now, countAttempt: true });
			await this.#armAlarm(now);
			return;
		}

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
	async retry(jobId: string): Promise<MutationResult> {
		const now = this.clock.now();
		const ok = this.repo.compareAndSet(jobId, ['FAILED', 'STALLED'], 'SCHEDULED', {
			now,
			runAfter: now,
			dispatchedAt: null,
		});
		if (ok) {
			await this.#armAlarm(now);
			return { ok: true };
		}
		// 理由を分けて返す, 保持期間を過ぎて消えたのか状態が違うのかで利用者の打つ手が変わる(ADR-0027)
		return { ok: false, reason: this.repo.find(jobId) ? 'invalid-state' : 'gone' };
	}

	/**
	 * 実行前のジョブの取り消し
	 * QUEUED以降はconsumerが既に実行を始めているかもしれず,取り消せたと嘘をつかない(ADR-0012)
	 */
	async cancel(jobId: string): Promise<MutationResult> {
		const now = this.clock.now();
		const ok = this.repo.compareAndSet(jobId, ['SCHEDULED'], 'CANCELLED', { now });
		// 投影のためにtickを呼ぶ,張らないと静かなシャードで読み取りモデルが取り消し前のまま残る
		if (ok) {
			await this.#armAlarm(now);
			return { ok: true };
		}
		return { ok: false, reason: this.repo.find(jobId) ? 'invalid-state' : 'gone' };
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
		const { jobs, readyCount } = this.repo.scheduleWindow(now, TICK_LIMIT);
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

		// 100件上限で分割して送る, concurrency>100だと1 tickの投入がこれを超える(ADR-0009)
		for (let i = 0; i < messages.length; i += SEND_BATCH_LIMIT) {
			await this.env.TSUMUGI_QUEUE.sendBatch(messages.slice(i, i + SEND_BATCH_LIMIT));
		}

		const projected = await this.#project();
		const { deleted, retryAt } = this.#sweep(now);

		// 上限まで読んだなら残りがある可能性が高いので即座に自分を起こし直す
		// 投入候補はreadyCountで見る, 実行中で窓が埋まっても投入すべき候補が無ければ起き直さない
		const hasMore = readyCount >= TICK_LIMIT || projected >= PROJECTION_LIMIT || deleted >= SWEEP_LIMIT;
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
		// 投影が成功したらカーソルを先に進める, 投影は冪等なので再処理は無害(#7)
		this.repo.deleteOutboxThrough(rows[rows.length - 1]!.seq);
		// メトリクスはカーソルの後, 非冪等なので冪等な投影と再試行単位を分ける(ADR-0016 / #7)
		// カーソルより後なので同じ行を二度書かない, 反面この便の失敗ぶんは載らずat-most-onceになる
		// 省略可能な機能なので失敗を捕捉し, ジョブ調停を含むtick全体を止めない
		try {
			// 明細と同じ材料から時系列を書く, sweepで明細が消えてもこちらは残る(ADR-0016)
			writeMetrics(
				this.env.TSUMUGI_METRICS,
				rows.map((row) => JSON.parse(row.snapshot) as JobRow),
			);
		} catch (error) {
			console.error('tsumugi: writeMetrics failed', error);
		}
		return rows.length;
	}

	/**
	 * 溜まったものを落とす
	 * 投影済みの終端ジョブと期限切れの重複排除キーを対象にする
	 */
	#sweep(now: number): { deleted: number; retryAt: number | null } {
		// 対象の有無を先に読む,状態をメモリに持つとDOのエビクトで掃除が止まる
		const state = this.repo.sweepState(now, this.retention);
		if (state.uniqueKeys) this.repo.sweepExpiredUniqueKeys(now);
		const deleted = state.jobs ? this.repo.sweepTerminal(now, this.retention, SWEEP_LIMIT) : 0;

		// 次に対象が出る時刻まで寝る
		// 稼働中が無くなるとalarmが張られず,掃除する機会が永久に来ない
		// 一定間隔で起き直すと失敗ジョブだけが残る状態で何もしない書き込みが積まれる
		const next = deleted > 0 ? this.repo.sweepState(now, this.retention).nextDueAt : state.nextDueAt;
		return { deleted, retryAt: next === null ? null : Math.max(next, now + 1_000) };
	}

	/** 履歴はアウトボックスに載るので, 記録してから遷移するとD1へ同じ便で運ばれる */
	#recordAttempt(jobId: string, attempt: number, state: string, startedAt: number | null, finishedAt: number, error: string | null): void {
		this.repo.recordAttempt({ job_id: jobId, attempt, state, started_at: startedAt, finished_at: finishedAt, error });
	}

	/** 予定より早い時刻にalarmが張られている場合は上書きしない */
	async #armAlarm(at: number): Promise<void> {
		const current = await this.ctx.storage.getAlarm();
		if (current === null || current > at) await this.ctx.storage.setAlarm(at);
	}
}
