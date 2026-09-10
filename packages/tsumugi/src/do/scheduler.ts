import { DurableObject } from 'cloudflare:workers';
import { configOf, createClient, type BindingConfig, type ClientEnv } from '../client/enqueue.js';
import { formatJobId, formatRunId, shardNameOf } from '../core/ids.js';
import {
	normalizeSchedules,
	nextOccurrence,
	type AnyScheduleDef,
	type AnySchedules,
	type NormalizedSchedule,
	type ScheduleContext,
} from '../core/recurring.js';
import { resolveShard } from '../core/shard.js';
import { systemClock, type Clock } from './clock.js';
import type { EnqueueInput } from './job-shard.js';
import type { StartInput, StartResult } from './run.js';
import { SchedulerRepo, type FiredPatch } from './scheduler-repo.js';
import type { ScheduleRow } from './scheduler-schema.js';

export type SchedulerEnv = ClientEnv & {
	/** flowのscheduleを使う場合のみ必要, 子のrunの起動用 */
	RUN?: DurableObjectNamespace<any>;
};

/** worker側がidFromNameに使う固定名, インスタンスは1つ(ADR-0040) */
export const SCHEDULER_DO_NAME = 'scheduler';

/** 1回のtickで発火するscheduleの上限, alarmのwall timeを有界に維持 */
const TICK_LIMIT = 50;

/** 正規化した定義のfingerprintを置くsettingのキー */
const FINGERPRINT_KEY = 'defs_fingerprint';

/** 一覧RPCが返す1件, RESTとダッシュボードがそのまま表示 */
export type ScheduleView = {
	name: string;
	kind: 'job' | 'flow';
	target: string;
	every_ms: number | null;
	cron: string | null;
	time_zone: string;
	overlap: 'skip' | 'overlap';
	paused: boolean;
	next_run_at: number;
	last_run_at: number | null;
	last_fired_at: number | null;
	last_job_id: string | null;
	last_run_id: string | null;
	last_skipped_at: number | null;
	skipped_count: number;
	last_error: string | null;
};

/** 一時停止RPCの結果 */
export type ScheduleMutationResult = { ok: true } | { ok: false; reason: 'not-found' };

/** 手動発火RPCの結果, 失敗の理由はRESTがそのまま返す */
export type ScheduleTriggerResult =
	{ ok: true; kind: 'job' | 'flow'; id: string } | { ok: false; reason: 'not-found' } | { ok: false; reason: 'failed'; error: string };

/** skip判定に使うJob DOの面, DOクラス非参照でDO実装が不要(ADR-0023) */
interface SchedulerJobStub extends Rpc.DurableObjectBranded {
	stateOf(jobId: string): Promise<string | null>;
}

/** 発火とskip判定に使うRun DOの面, DO本体の型を使うと型の展開が過剰に深い */
interface SchedulerRunStub extends Rpc.DurableObjectBranded {
	start(input: StartInput): Promise<StartResult>;
	state(): Promise<string | null>;
}

/**
 * Scheduler DOの外から見える面
 * 匿名クラスのまま推論させるとDurableObjectのprotectedが型定義に混入し宣言を出力不能
 */
export interface TsumugiSchedulerInstance extends Rpc.DurableObjectBranded {
	/** テストからの差し替え用にpublic */
	clock: Clock;
	sync(): Promise<void>;
	list(): Promise<ScheduleView[]>;
	setPaused(name: string, paused: boolean): Promise<ScheduleMutationResult>;
	trigger(name: string): Promise<ScheduleTriggerResult>;
	alarm(): Promise<void>;
}

/** `createSchedulerClass`が返すDOクラス, wranglerのclass_nameはこれをエクスポートした名前を指す */
export type SchedulerClass = new (ctx: DurableObjectState, env: SchedulerEnv) => TsumugiSchedulerInstance;

export type SchedulerOptions = {
	schedules: AnySchedules;
	bindings: Record<string, BindingConfig>;
	/** 検証用の登録名, performersとflowsのキー */
	targets: { bindings: readonly string[]; flows: readonly string[] };
	/** 失敗を知らせる先のbinding(#30), 定期実行で投入するジョブにも同じ宛先が必要 */
	failureBinding?: string | null;
};

/** Job DOの非終端の状態, 前回がこのいずれかならskip */
const JOB_ACTIVE: readonly string[] = ['SCHEDULED', 'QUEUED', 'RUNNING'];

/** ノードのerror列と同じ方針, stackは含めず理由だけを保存 */
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * 定期実行の調停役(ADR-0040)
 *
 * 定義はコードのclosureから取得し、DOは次回時刻と直近の観測だけを持つ
 * 発火は決定的IDで冪等にし、二重発火は既存の重複排除(ADR-0029)で無効化
 */
export function createSchedulerClass({ schedules, bindings, targets, failureBinding }: SchedulerOptions): SchedulerClass {
	// 定義の誤りはdefineTsumugiの時点でエラー, 発火まで発覚しないと定期実行が警告なく停止
	const { schedules: normalized, fingerprint } = normalizeSchedules(schedules, {
		bindings: targets.bindings,
		flows: targets.flows,
		shardsOf: (binding) => configOf(bindings, binding)?.shards ?? 1,
	});
	const client = createClient<SchedulerEnv>(bindings, failureBinding === undefined ? {} : { failureBinding });

	return class TsumugiScheduler extends DurableObject<SchedulerEnv> {
		/** テストからの差し替え用にpublic */
		clock: Clock = systemClock;

		#repo: SchedulerRepo | undefined;
		/** tickが実行中か, 同時実行を1つに制限するためのフラグ */
		#ticking = false;

		get repo(): SchedulerRepo {
			if (!this.#repo) this.#repo = new SchedulerRepo(this.ctx.storage);
			return this.#repo;
		}

		/**
		 * worker入口からの同期の契機
		 * 定義は常に自分のコード版から取得し、引数でスナップショットを受け取る必要が無い(ADR-0040)
		 */
		async sync(): Promise<void> {
			this.#reconcile(this.clock.now());
			await this.#armNext();
		}

		async list(): Promise<ScheduleView[]> {
			return this.repo.rows().map((row) => ({
				name: row.name,
				kind: row.kind as 'job' | 'flow',
				target: row.target,
				every_ms: row.every_ms,
				cron: row.cron,
				time_zone: row.time_zone,
				overlap: row.overlap as 'skip' | 'overlap',
				paused: row.paused === 1,
				next_run_at: row.next_run_at,
				last_run_at: row.last_run_at,
				last_fired_at: row.last_fired_at,
				last_job_id: row.last_job_id,
				last_run_id: row.last_run_id,
				last_skipped_at: row.last_skipped_at,
				skipped_count: row.skipped_count,
				last_error: row.last_error,
			}));
		}

		/**
		 * 一時停止の切り替え
		 * 停止中に経過した回は再開時にすべて破棄し、次回は現在から見た次の境界
		 */
		async setPaused(name: string, paused: boolean): Promise<ScheduleMutationResult> {
			const now = this.clock.now();
			this.#reconcile(now);
			const row = this.repo.find(name);
			if (!row) return { ok: false, reason: 'not-found' };
			// 停止中でない行へのresumeは無変更, 発火待ちの予定は維持
			const elapsed = !paused && row.paused === 1 && row.next_run_at <= now;
			this.repo.setPaused(
				name,
				paused,
				elapsed ? nextOccurrence({ everyMs: row.every_ms, cron: row.cron, timeZone: row.time_zone }, row.next_run_at, now) : null,
				now,
			);
			await this.#armNext();
			return { ok: true };
		}

		/**
		 * 手動発火, 一時停止中も対象でoverlapの判定は行わない
		 * 予定は進めず、次の定期の発火時刻は変わらない
		 */
		async trigger(name: string): Promise<ScheduleTriggerResult> {
			const now = this.clock.now();
			this.#reconcile(now);
			const row = this.repo.find(name);
			const def = Object.hasOwn(schedules, name) ? schedules[name] : undefined;
			if (!row || !def) return { ok: false, reason: 'not-found' };

			try {
				// 通常のlocalIdは数字終端, 末尾-manualの形式と衝突なし
				const fired = await this.#dispatch(row, def, now, `${name}-${now}-manual`);
				this.repo.markFired(name, fired, null, now);
				return { ok: true, kind: row.kind as 'job' | 'flow', id: (fired.jobId ?? fired.runId)! };
			} catch (error) {
				const message = messageOf(error);
				this.repo.markError(name, message, null, now);
				return { ok: false, reason: 'failed', error: message };
			}
		}

		async alarm(): Promise<void> {
			try {
				await this.#tick();
			} catch (error) {
				// alarm()がthrowするとworkerdのリトライは6回で枯渇, 捕捉して必ず再設定
				console.error('tsumugi: scheduler tick failed', error);
				await this.ctx.storage.setAlarm(this.clock.now() + 5_000);
			}
		}

		async #tick(): Promise<void> {
			// 発火のRPC待ちの間に別のalarmやsyncが入り得る, 実行中の側に処理を集約し終了
			if (this.#ticking) return;
			this.#ticking = true;
			try {
				const now = this.clock.now();
				// デプロイ直後の自己同期, トラフィックが無くても既存alarmの発火で定義に追いつく
				this.#reconcile(now);

				for (const row of this.repo.due(now, TICK_LIMIT)) {
					const def = Object.hasOwn(schedules, row.name) ? schedules[row.name] : undefined;
					if (!def) {
						// reconcileで消えているはずの行への防御, 定義の無い行は発火不能
						this.repo.remove([row.name]);
						continue;
					}
					await this.#fire(row, def, now);
				}
				await this.#armNext();
			} finally {
				this.#ticking = false;
			}
		}

		/** 行とコードの定義の突き合わせ */
		#reconcile(now: number): void {
			const rows = new Map(this.repo.rows().map((row) => [row.name, row]));
			if (
				this.repo.readSetting(FINGERPRINT_KEY) === fingerprint &&
				rows.size === normalized.length &&
				normalized.every((spec) => {
					const row = rows.get(spec.name);
					return row !== undefined && rowMatchesSpec(row, spec);
				})
			) {
				return;
			}

			for (const spec of normalized) {
				const row = rows.get(spec.name);
				if (!row) {
					this.repo.insert(spec, nextOccurrence(spec, null, now), now);
					continue;
				}
				rows.delete(spec.name);
				const timingChanged = !timingMatchesSpec(row, spec);
				if (timingChanged || row.kind !== spec.kind || row.target !== spec.target || row.overlap !== spec.overlap) {
					// 間隔が変わった場合だけ次回を再計算, 表示項目の変更では位相を維持
					this.repo.updateSpec(spec, timingChanged ? nextOccurrence(spec, null, now) : null, now);
				}
			}
			this.repo.remove([...rows.keys()]);
			this.repo.writeSetting(FINGERPRINT_KEY, fingerprint);
		}

		/**
		 * 1件の発火, 予定時刻はrow.next_run_atで確定している
		 * 失敗しても理由を残して次回へ進める, 進めないと同じ行が先頭に残存し他のscheduleが発火不能
		 */
		async #fire(row: ScheduleRow, def: AnyScheduleDef, now: number): Promise<void> {
			const occurrence = row.next_run_at;
			const next = nextOccurrence({ everyMs: row.every_ms, cron: row.cron, timeZone: row.time_zone }, occurrence, now);

			try {
				if (row.overlap === 'skip' && (await this.#previousActive(row))) {
					this.repo.markSkipped(row.name, next, now);
					return;
				}

				// IDは決定的, 再発火しても同じIDの再投入は既存を返す(ADR-0029)
				const fired = await this.#dispatch(row, def, occurrence, `${row.name}-${occurrence}`);
				this.repo.markFired(row.name, fired, next, now);
			} catch (error) {
				// 1件の失敗でも他のscheduleは継続, 理由は一覧に表示され外部から確認可能
				console.error(`tsumugi: schedule ${row.name} failed to fire`, error);
				this.repo.markError(row.name, messageOf(error), next, now);
			}
		}

		/** 投入またはrunの開始, localIdは定期と手動で規則が異なり呼び出し側が決める */
		async #dispatch(row: ScheduleRow, def: AnyScheduleDef, occurrence: number, localId: string): Promise<FiredPatch> {
			const resolved = await this.#resolve(def, { scheduledAt: occurrence });

			if (row.kind === 'job') {
				const binding = def.binding as string;
				const shard = resolveShard(binding, configOf(bindings, binding)?.shards ?? 1, def.partitionKey);
				const jobId = formatJobId({ binding, shard, localId });
				await client.enqueue(this.env, {
					binding,
					payload: resolved,
					id: jobId,
					...(def.partitionKey !== undefined ? { partitionKey: def.partitionKey } : {}),
					...jobOptionsOf(def),
				} as EnqueueInput);
				return { occurrence, jobId };
			}

			const flow = def.flow as string;
			const runId = formatRunId({ flow, localId });
			await this.#runStub(runId).start({
				flow,
				input: resolved,
				...(def.deadlineMs !== undefined ? { deadlineMs: def.deadlineMs } : {}),
			});
			return { occurrence, runId };
		}

		/** 前回の発火がまだ終端に達していないか, overlap='skip'の判定 */
		async #previousActive(row: ScheduleRow): Promise<boolean> {
			if (row.kind === 'job') {
				if (row.last_job_id === null) return false;
				const namespace = this.env.JOB_SHARD as DurableObjectNamespace<SchedulerJobStub>;
				const stub = namespace.get(namespace.idFromName(shardNameOf(row.last_job_id)));
				const state = await stub.stateOf(row.last_job_id);
				// 削除済みのnullは終了扱い, 保持期間を過ぎるほど前の発火を待つ理由が無い
				return state !== null && JOB_ACTIVE.includes(state);
			}
			if (row.last_run_id === null) return false;
			// 削除済みのrunはstate()がnullを返す, 照会で空のDOが再生成されるが行もalarmも無く無害
			const state = await this.#runStub(row.last_run_id).state();
			return state === 'RUNNING';
		}

		/** payloadまたはinputを発火時に解決, 関数は予定時刻を受け取る */
		async #resolve(def: AnyScheduleDef, context: ScheduleContext): Promise<unknown> {
			const source = def.binding !== undefined ? def.payload : def.input;
			return typeof source === 'function' ? await (source as (context: ScheduleContext) => unknown)(context) : source;
		}

		#runStub(runId: string): DurableObjectStub<SchedulerRunStub> {
			const namespace = this.env.RUN as DurableObjectNamespace<SchedulerRunStub> | undefined;
			if (!namespace) throw new Error('RUN binding is not configured, add the Run DO binding to wrangler');
			return namespace.get(namespace.idFromName(runId));
		}

		/**
		 * 次の予定へのalarm設定
		 * 予定は発火のたびに後ろへ動き、早い時刻優先ではなく常に再設定
		 */
		async #armNext(): Promise<void> {
			const next = this.repo.minNextRunAt();
			if (next === null) {
				await this.ctx.storage.deleteAlarm();
				return;
			}
			// 過去の時刻は即時発火, TICK_LIMITで中断した残りをここで処理
			await this.ctx.storage.setAlarm(next);
		}
	};
}

/** 保存済み予定が現在のタイムゾーン規則でも同じcron分か確認 */
function timingMatchesSpec(row: ScheduleRow, spec: NormalizedSchedule): boolean {
	if (row.every_ms !== spec.everyMs || row.cron !== spec.cron || row.time_zone !== spec.timeZone) return false;
	if (spec.cron === null) return true;
	return nextOccurrence(spec, null, row.next_run_at - 1) === row.next_run_at;
}

function rowMatchesSpec(row: ScheduleRow, spec: NormalizedSchedule): boolean {
	return timingMatchesSpec(row, spec) && row.kind === spec.kind && row.target === spec.target && row.overlap === spec.overlap;
}

/** scheduleの定義から投入設定だけを抽出, タイミング系のキーは対象外(ADR-0040) */
function jobOptionsOf(def: AnyScheduleDef): Partial<EnqueueInput> {
	return {
		...(def.maxAttempts !== undefined ? { maxAttempts: def.maxAttempts } : {}),
		...(def.backoff !== undefined ? { backoff: def.backoff } : {}),
		...(def.timeoutMs !== undefined ? { timeoutMs: def.timeoutMs } : {}),
		...(def.priority !== undefined ? { priority: def.priority } : {}),
		...(def.guarantee !== undefined ? { guarantee: def.guarantee } : {}),
		...(def.concurrencyKey !== undefined ? { concurrencyKey: def.concurrencyKey } : {}),
	};
}
