import { DurableObject } from 'cloudflare:workers';
import { configOf, createClient, type BindingConfig, type ClientEnv, type EnqueueHook } from '../client/enqueue.js';
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
import { ACTIVE_STATES } from '../core/transitions.js';
import type { SettledTarget } from '../core/types.js';
import { systemClock, type Clock } from './clock.js';
import type { EnqueueInput } from './job-shard.js';
import type { RunLifecycleStub } from './run.js';
import { SchedulerRepo, type FiredPatch } from './scheduler-repo.js';
import type { ScheduleRow } from './scheduler-schema.js';

export type SchedulerEnv = ClientEnv & {
	/** flowのschedule使用時のみ必要 */
	RUN?: DurableObjectNamespace<any>;
};

/** idFromName用の固定名, 単一インスタンス(ADR-0040) */
export const SCHEDULER_DO_NAME = 'scheduler';

// alarmのwall time制限
const TICK_LIMIT = 50;

const FINGERPRINT_KEY = 'defs_fingerprint';

const MANUAL_SEQ_KEY = 'manual_seq';

export type ScheduleView = {
	name: string;
	kind: 'job' | 'flow';
	target: string;
	every_ms: number | null;
	cron: string | null;
	time_zone: string;
	overlap: 'skip' | 'overlap';
	paused: boolean;
	next_occurrence_at: number;
	last_occurrence_at: number | null;
	last_fired_at: number | null;
	last_job_id: string | null;
	last_run_id: string | null;
	last_skipped_at: number | null;
	skipped_count: number;
	last_error: string | null;
};

export type ScheduleMutationResult = { ok: true } | { ok: false; reason: 'unknown' };

export type ScheduleTriggerResult =
	{ ok: true; kind: 'job' | 'flow'; id: string } | { ok: false; reason: 'unknown' } | { ok: false; reason: 'failed'; error: string };

// DOクラス非参照でDO実装不要(ADR-0023)
interface SchedulerJobStub extends Rpc.DurableObjectBranded {
	stateOf(jobId: string): Promise<string | null>;
}

// 匿名クラス推論ではprotected混入で宣言出力不可
interface TsumugiSchedulerInstance extends Rpc.DurableObjectBranded {
	/** テストからの差し替え用にpublic */
	clock: Clock;
	sync(): Promise<void>;
	list(): Promise<ScheduleView[]>;
	setPaused(name: string, paused: boolean): Promise<ScheduleMutationResult>;
	trigger(name: string): Promise<ScheduleTriggerResult>;
	alarm(): Promise<void>;
}

/** `createSchedulerClass`の戻り値, wranglerのclass_nameはそのエクスポート名 */
export type SchedulerClass = new (ctx: DurableObjectState, env: SchedulerEnv) => TsumugiSchedulerInstance;

type SchedulerOptions = {
	schedules: AnySchedules;
	bindings: Record<string, BindingConfig>;
	targets: { bindings: readonly string[]; flows: readonly string[] };
	/** 失敗通知先のbinding(#30), 定期実行のジョブにも同じ宛先が必要 */
	failureBinding?: string | null;
	/** 終端通知の宛先と対象(#96), 定期実行のジョブにも同じ値が必要 */
	settled?: SettledTarget | null;
	/** 投入時の既定値付与フック(#96), 定期実行の投入にも適用 */
	onEnqueue?: EnqueueHook;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * 定義はclosureから取得(ADR-0040)
 * 二重発火は決定的IDの重複排除で無効化(ADR-0029)
 */
export function createSchedulerClass({
	schedules,
	bindings,
	targets,
	failureBinding,
	settled,
	onEnqueue,
}: SchedulerOptions): SchedulerClass {
	// 定義の誤りはdefineTsumugi時点でエラー, 発火時の発覚では警告なく停止
	const { schedules: normalized, fingerprint } = normalizeSchedules(schedules, {
		bindings: targets.bindings,
		flows: targets.flows,
		shardsOf: (binding) => configOf(bindings, binding)?.shards ?? 1,
	});
	const client = createClient<SchedulerEnv>(
		bindings,
		{
			...(failureBinding === undefined ? {} : { failureBinding }),
			...(settled === undefined ? {} : { settled }),
		},
		onEnqueue ? { onEnqueue } : {},
	);

	return class TsumugiScheduler extends DurableObject<SchedulerEnv> {
		/** テストからの差し替え用にpublic */
		clock: Clock = systemClock;

		#repo: SchedulerRepo | undefined;
		#ticking = false;

		get repo(): SchedulerRepo {
			if (!this.#repo) this.#repo = new SchedulerRepo(this.ctx.storage);
			return this.#repo;
		}

		// 定義はDO自身のコードから取得(ADR-0040)
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
				next_occurrence_at: row.next_occurrence_at,
				last_occurrence_at: row.last_occurrence_at,
				last_fired_at: row.last_fired_at,
				last_job_id: row.last_job_id,
				last_run_id: row.last_run_id,
				last_skipped_at: row.last_skipped_at,
				skipped_count: row.skipped_count,
				last_error: row.last_error,
			}));
		}

		async setPaused(name: string, paused: boolean): Promise<ScheduleMutationResult> {
			const now = this.clock.now();
			this.#reconcile(now);
			const row = this.repo.find(name);
			if (!row) return { ok: false, reason: 'unknown' };
			// 非停止行へのresumeは予定維持
			const elapsed = !paused && row.paused === 1 && row.next_occurrence_at <= now;
			this.repo.setPaused(
				name,
				paused,
				elapsed ? nextOccurrence({ everyMs: row.every_ms, cron: row.cron, timeZone: row.time_zone }, row.next_occurrence_at, now) : null,
				now,
			);
			await this.#armNext();
			return { ok: true };
		}

		async trigger(name: string): Promise<ScheduleTriggerResult> {
			const now = this.clock.now();
			this.#reconcile(now);
			const row = this.repo.find(name);
			const def = Object.hasOwn(schedules, name) ? schedules[name] : undefined;
			if (!row || !def) return { ok: false, reason: 'unknown' };

			// 連番で同一ミリ秒の再発火もID区別
			const seq = Number(this.repo.readSetting(MANUAL_SEQ_KEY) ?? '0') + 1;
			this.repo.writeSetting(MANUAL_SEQ_KEY, String(seq));

			try {
				// 定期のlocalIdは数字終端, -manual終端と衝突なし
				const fired = await this.#dispatch(row, def, now, `${name}-${now}-${seq}-manual`);
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
				// alarm()のthrowはworkerdリトライ6回で終了
				console.error('tsumugi: scheduler tick failed', error);
				// tick中のsync, triggerが設定した早い予定は維持
				const retryAt = this.clock.now() + 5_000;
				const current = await this.ctx.storage.getAlarm();
				if (current === null || current > retryAt) await this.ctx.storage.setAlarm(retryAt);
			}
		}

		async #tick(): Promise<void> {
			// 発火RPC待ち中の別alarm, syncは実行中tickへ集約
			if (this.#ticking) return;
			this.#ticking = true;
			try {
				const now = this.clock.now();
				// デプロイ直後の同期, リクエスト無しでも既存alarmで定義反映
				this.#reconcile(now);

				for (const due of this.repo.due(now, TICK_LIMIT)) {
					const def = Object.hasOwn(schedules, due.name) ? schedules[due.name] : undefined;
					if (!def) {
						// reconcileで削除済みのはずの行への対処, 定義なしは発火不可
						this.repo.remove([due.name]);
						continue;
					}
					// 前回発火のRPC待ち中の一時停止, 再開を考慮し直前の行で再判定
					const row = this.repo.find(due.name);
					if (!row || row.paused === 1 || row.next_occurrence_at > now) continue;
					await this.#fire(row, def, now);
				}
				await this.#armNext();
			} finally {
				this.#ticking = false;
			}
		}

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
					// 次回再計算は間隔変更時のみ, 他の変更では位相維持
					this.repo.updateSpec(spec, timingChanged ? nextOccurrence(spec, null, now) : null, now);
				}
			}
			this.repo.remove([...rows.keys()]);
			this.repo.writeSetting(FINGERPRINT_KEY, fingerprint);
		}

		// 失敗時も次回へ進行, 先頭行の残存による他schedule停止防止
		async #fire(row: ScheduleRow, def: AnyScheduleDef, now: number): Promise<void> {
			const occurrence = row.next_occurrence_at;
			const next = nextOccurrence({ everyMs: row.every_ms, cron: row.cron, timeZone: row.time_zone }, occurrence, now);

			try {
				if (row.overlap === 'skip' && (await this.#previousActive(row))) {
					this.repo.markSkipped(row.name, next, now);
					return;
				}

				// 決定的ID, 再発火時は既存を返却(ADR-0029)
				const fired = await this.#dispatch(row, def, occurrence, `${row.name}-${occurrence}`);
				this.repo.markFired(row.name, fired, next, now);
			} catch (error) {
				console.error(`tsumugi: schedule ${row.name} failed to fire`, error);
				this.repo.markError(row.name, messageOf(error), next, now);
			}
		}

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

		async #previousActive(row: ScheduleRow): Promise<boolean> {
			if (row.kind === 'job') {
				if (row.last_job_id === null) return false;
				const namespace = this.env.JOB_SHARD as DurableObjectNamespace<SchedulerJobStub>;
				const stub = namespace.get(namespace.idFromName(shardNameOf(row.last_job_id)));
				const state = await stub.stateOf(row.last_job_id);
				// 削除済み(null)は終了扱い, 保持期間超過の発火は待機不要
				return state !== null && (ACTIVE_STATES as readonly string[]).includes(state);
			}
			if (row.last_run_id === null) return false;
			// 削除済みrunはnull, 照会で再生成される空のDOは行もalarmも無く無害
			const state = await this.#runStub(row.last_run_id).state();
			return state === 'RUNNING';
		}

		async #resolve(def: AnyScheduleDef, context: ScheduleContext): Promise<unknown> {
			const source = def.binding !== undefined ? def.payload : def.input;
			return typeof source === 'function' ? await (source as (context: ScheduleContext) => unknown)(context) : source;
		}

		#runStub(runId: string): DurableObjectStub<RunLifecycleStub> {
			const namespace = this.env.RUN as DurableObjectNamespace<RunLifecycleStub> | undefined;
			if (!namespace) throw new Error('RUN binding is not configured, add the Run DO binding to wrangler');
			return namespace.get(namespace.idFromName(runId));
		}

		// 予定は発火ごとに後方移動し常に上書き
		async #armNext(): Promise<void> {
			const next = this.repo.minNextRunAt();
			if (next === null) {
				await this.ctx.storage.deleteAlarm();
				return;
			}
			// 過去時刻は即時発火, TICK_LIMIT超過分の処理用
			await this.ctx.storage.setAlarm(next);
		}
	};
}

// 保存済み予定が現行タイムゾーン規則でも同じcron分か
function timingMatchesSpec(row: ScheduleRow, spec: NormalizedSchedule): boolean {
	if (row.every_ms !== spec.everyMs || row.cron !== spec.cron || row.time_zone !== spec.timeZone) return false;
	if (spec.cron === null) return true;
	return nextOccurrence(spec, null, row.next_occurrence_at - 1) === row.next_occurrence_at;
}

function rowMatchesSpec(row: ScheduleRow, spec: NormalizedSchedule): boolean {
	return timingMatchesSpec(row, spec) && row.kind === spec.kind && row.target === spec.target && row.overlap === spec.overlap;
}

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
