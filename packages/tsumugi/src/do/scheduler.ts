import { DurableObject } from 'cloudflare:workers';
import { createClient, type BindingConfig, type ClientEnv } from '../client/enqueue.js';
import { formatJobId, formatRunId, shardNameOf } from '../core/ids.js';
import { normalizeSchedules, nextOccurrence, type AnyScheduleDef, type AnySchedules, type ScheduleContext } from '../core/recurring.js';
import { resolveShard } from '../core/shard.js';
import { systemClock, type Clock } from './clock.js';
import type { EnqueueInput } from './job-shard.js';
import type { StartInput, StartResult } from './run.js';
import { SchedulerRepo } from './scheduler-repo.js';
import type { ScheduleRow } from './scheduler-schema.js';

export type SchedulerEnv = ClientEnv & {
	/** flowのscheduleを使う場合のみ必要, 子のrunを起動する */
	RUN?: DurableObjectNamespace<any>;
};

/** worker側がidFromNameに使う固定名, インスタンスは1つ(ADR-0040) */
export const SCHEDULER_DO_NAME = 'scheduler';

/** 1回のtickで発火するscheduleの上限, alarmのwall timeを有界にする */
const TICK_LIMIT = 50;

/** 正規化した定義のfingerprintを置くsettingのキー */
const FINGERPRINT_KEY = 'defs_fingerprint';

/** 一覧RPCが返す1件, RESTとダッシュボードがそのまま表示する */
export type ScheduleView = {
	name: string;
	kind: 'job' | 'flow';
	target: string;
	every_ms: number | null;
	cron: string | null;
	overlap: 'skip' | 'overlap';
	next_run_at: number;
	last_run_at: number | null;
	last_fired_at: number | null;
	last_job_id: string | null;
	last_run_id: string | null;
	last_skipped_at: number | null;
	skipped_count: number;
	last_error: string | null;
};

/** skip判定に使うJob DOの面, DOクラス非参照でDO実装を持たずに済む(ADR-0023) */
interface SchedulerJobStub extends Rpc.DurableObjectBranded {
	stateOf(jobId: string): Promise<string | null>;
}

/** 発火とskip判定に使うRun DOの面, DO本体の型を通すと型の展開が深くなりすぎる */
interface SchedulerRunStub extends Rpc.DurableObjectBranded {
	start(input: StartInput): Promise<StartResult>;
	state(): Promise<string | null>;
}

/**
 * Scheduler DOの外から見える面
 * 匿名クラスのまま推論させるとDurableObjectのprotectedが型定義に漏れて宣言を出力できない
 */
export interface TsumugiSchedulerInstance extends Rpc.DurableObjectBranded {
	/** テストから差し替えるためpublicにしている */
	clock: Clock;
	sync(): Promise<void>;
	list(): Promise<ScheduleView[]>;
	alarm(): Promise<void>;
}

/** `createSchedulerClass`が返すDOクラス, wranglerのclass_nameはこれをエクスポートした名前を指す */
export type SchedulerClass = new (ctx: DurableObjectState, env: SchedulerEnv) => TsumugiSchedulerInstance;

export type SchedulerOptions = {
	schedules: AnySchedules;
	bindings: Record<string, BindingConfig>;
	/** 検証用の登録名, performersとflowsのキー */
	targets: { bindings: readonly string[]; flows: readonly string[] };
};

/** Job DOの非終端の状態, 前回がこのいずれかならskipする */
const JOB_ACTIVE: readonly string[] = ['SCHEDULED', 'QUEUED', 'RUNNING'];

/** ノードのerror列と同じ方針, stackは載せず理由だけを残す */
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * 定期実行の調停役(ADR-0040)
 *
 * 定義はコードのclosureから引き, DOは次回時刻と直近の観測だけを持つ
 * 発火は決定的IDで冪等にし, 二重発火を既存の重複排除(ADR-0029)に吸収させる
 */
export function createSchedulerClass({ schedules, bindings, targets }: SchedulerOptions): SchedulerClass {
	// 定義の誤りはdefineTsumugiの時点で落とす, 発火まで気付けないと定期実行が黙って止まる
	const { schedules: normalized, fingerprint } = normalizeSchedules(schedules, {
		bindings: targets.bindings,
		flows: targets.flows,
		shardsOf: (binding) => bindings[binding]?.shards ?? 1,
	});
	const client = createClient<SchedulerEnv>(bindings);

	return class TsumugiScheduler extends DurableObject<SchedulerEnv> {
		/** テストから差し替えるためpublicにしている */
		clock: Clock = systemClock;

		#repo: SchedulerRepo | undefined;
		/** tickが実行中か, 重なりを1本に絞るために持つ */
		#ticking = false;

		get repo(): SchedulerRepo {
			if (!this.#repo) this.#repo = new SchedulerRepo(this.ctx.storage);
			return this.#repo;
		}

		/**
		 * worker入口からの同期の契機
		 * 定義は常に自分のコード版から引くので, 引数でスナップショットを受け取る必要がない(ADR-0040)
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
				overlap: row.overlap as 'skip' | 'overlap',
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

		async alarm(): Promise<void> {
			try {
				await this.#tick();
			} catch (error) {
				// alarm()がthrowするとworkerdのリトライは6回で尽きる, 捕捉して必ず設定し直す
				console.error('tsumugi: scheduler tick failed', error);
				await this.ctx.storage.setAlarm(this.clock.now() + 5_000);
			}
		}

		async #tick(): Promise<void> {
			// 発火のRPC待ちの間に別のalarmやsyncが入り得る, 走っている方に任せて降りる
			if (this.#ticking) return;
			this.#ticking = true;
			try {
				const now = this.clock.now();
				// デプロイ直後の自己同期, トラフィックが無くても既存alarmの発火で定義に追いつく
				this.#reconcile(now);

				for (const row of this.repo.due(now, TICK_LIMIT)) {
					const def = schedules[row.name];
					if (!def) {
						// reconcileで消えているはずの防御, 定義の無い行は発火できない
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

		/** 行とコードの定義を突き合わせる, fingerprintが一致すれば差分なし */
		#reconcile(now: number): void {
			if (this.repo.readSetting(FINGERPRINT_KEY) === fingerprint) return;

			const rows = new Map(this.repo.rows().map((row) => [row.name, row]));
			for (const spec of normalized) {
				const row = rows.get(spec.name);
				if (!row) {
					this.repo.insert(spec, nextOccurrence(spec, null, now), now);
					continue;
				}
				rows.delete(spec.name);
				const timingChanged = row.every_ms !== spec.everyMs || row.cron !== spec.cron;
				if (timingChanged || row.kind !== spec.kind || row.target !== spec.target || row.overlap !== spec.overlap) {
					// 間隔が変わった場合だけ次回を引き直す, 表示項目の変更で位相を崩さない
					this.repo.updateSpec(spec, timingChanged ? nextOccurrence(spec, null, now) : null, now);
				}
			}
			this.repo.remove([...rows.keys()]);
			this.repo.writeSetting(FINGERPRINT_KEY, fingerprint);
		}

		/**
		 * 1件の発火, 予定時刻はrow.next_run_atで確定している
		 * 失敗しても理由を残して次回へ進める, 進めないと同じ行が先頭に居座り他のscheduleが発火しない
		 */
		async #fire(row: ScheduleRow, def: AnyScheduleDef, now: number): Promise<void> {
			const occurrence = row.next_run_at;
			const next = nextOccurrence({ everyMs: row.every_ms, cron: row.cron }, occurrence, now);

			try {
				if (row.overlap === 'skip' && (await this.#previousActive(row))) {
					this.repo.markSkipped(row.name, next, now);
					return;
				}

				const resolved = await this.#resolve(def, { scheduledAt: occurrence });

				if (row.kind === 'job') {
					const binding = def.binding as string;
					// 決定的IDにする, 再発火しても同じIDの再投入は既存を返す(ADR-0029)
					const shard = resolveShard(binding, bindings[binding]?.shards ?? 1, def.partitionKey);
					const jobId = formatJobId({ binding, shard, localId: `${row.name}-${occurrence}` });
					await client.enqueue(this.env, {
						binding,
						payload: resolved,
						id: jobId,
						...(def.partitionKey !== undefined ? { partitionKey: def.partitionKey } : {}),
						...jobOptionsOf(def),
					} as EnqueueInput);
					this.repo.markFired(row.name, { occurrence, jobId }, next, now);
				} else {
					const flow = def.flow as string;
					const runId = formatRunId({ flow, localId: `${row.name}-${occurrence}` });
					await this.#runStub(runId).start({
						flow,
						input: resolved,
						...(def.deadlineMs !== undefined ? { deadlineMs: def.deadlineMs } : {}),
					});
					this.repo.markFired(row.name, { occurrence, runId }, next, now);
				}
			} catch (error) {
				// 1件の失敗で他のscheduleを止めない, 理由は一覧に出るので外から気付ける
				console.error(`tsumugi: schedule ${row.name} failed to fire`, error);
				this.repo.markError(row.name, messageOf(error), next, now);
			}
		}

		/** 前回の発火がまだ終端に達していないか, overlap='skip'の判定 */
		async #previousActive(row: ScheduleRow): Promise<boolean> {
			if (row.kind === 'job') {
				if (row.last_job_id === null) return false;
				const namespace = this.env.JOB_SHARD as DurableObjectNamespace<SchedulerJobStub>;
				const stub = namespace.get(namespace.idFromName(shardNameOf(row.last_job_id)));
				const state = await stub.stateOf(row.last_job_id);
				// 掃除済みのnullは終了扱い, 保持期間を過ぎるほど前の発火を待つ理由がない
				return state !== null && JOB_ACTIVE.includes(state);
			}
			if (row.last_run_id === null) return false;
			// 削除済みのrunはstate()がnullを返す, 照会で空のDOが再生成されるが行もalarmも無いので無害
			const state = await this.#runStub(row.last_run_id).state();
			return state === 'RUNNING';
		}

		/** payloadまたはinputを発火時に解決する, 関数は予定時刻を受け取る */
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
		 * 次の予定へalarmを張る
		 * 予定は発火のたびに後ろへ動くので, 早い時刻優先ではなく常に置き直す
		 */
		async #armNext(): Promise<void> {
			const next = this.repo.minNextRunAt();
			if (next === null) {
				await this.ctx.storage.deleteAlarm();
				return;
			}
			// 過去の時刻は即時発火になる, TICK_LIMITで打ち切った残りをここで拾う
			await this.ctx.storage.setAlarm(next);
		}
	};
}

/** scheduleの定義から投入設定だけを抜き出す, タイミング系のキーは持たない(ADR-0040) */
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
