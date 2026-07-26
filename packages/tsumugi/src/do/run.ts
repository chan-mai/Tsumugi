import { DurableObject } from 'cloudflare:workers';
import { createId } from '@paralleldrive/cuid2';
import type { BindingConfig, ClientEnv } from '../client/enqueue.js';
import { createClient } from '../client/enqueue.js';
import { assertNodeId, type AnyFlow, type FlowNode, type Flows, type FlowShape, type NodeJobOptions, shapeOf } from '../core/flow.js';
import { formatJobId, shardNameOf } from '../core/ids.js';
import { advance, type NodeEvent, type NodeState, type RunDecision, type SpawnRequest } from '../core/run.js';
import { resolveShard } from '../core/shard.js';
import type { Retention } from '../core/types.js';
import { systemClock, type Clock } from './clock.js';
import type { EnqueueInput, MutationResult, TsumugiJobShard } from './job-shard.js';
import { projectRun } from '../projection/run-projector.js';
import type { NodeRow } from './run-schema.js';
import { RunRepo } from './run-repo.js';

export type RunEnv = ClientEnv & { TSUMUGI_DB: D1Database };

/** 1回のtickで扱うノードの上限, alarmのwall timeを有界にする */
const TICK_LIMIT = 200;

/** 1回のtickで進行判断を回す上限, グラフの深さぶん回れば足りる */
const ADVANCE_ROUNDS = 32;

/** 1回の投影で流すアウトボックスの上限 */
const PROJECTION_LIMIT = 200;

/** 1つのrunに入るノード数の既定上限(ADR-0035) */
export const DEFAULT_MAX_NODES = 10_000;

/** 済んだrunをDOに残す時間,投影が追いつく余裕を見て既定5分(ADR-0034) */
const DEFAULT_SWEEP_AFTER_MS = 5 * 60 * 1000;

/** 失敗したrunをDOに残す時間, 再開を受け付ける期間(ADR-0034) */
const DEFAULT_FAILED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type RunSettings = {
	/** 1つのrunに入るノード数の上限(ADR-0035) */
	maxNodes?: number;
	/** 済んだrun(COMPLETED / CANCELLED)をDOに残す時間 */
	sweepAfterMs?: number;
	/** 失敗したrunをDOに残す時間, 手動再開を受け付ける期間 */
	failedRetentionMs?: number;
};

export type StartInput = { flow: string; input: unknown };
export type StartResult = { id: string; created: boolean };

/** ノード1件ぶんの投入内容, 宛先はRun DOが被せる */
type BuiltJob = Omit<EnqueueInput, 'binding' | 'id' | 'runId' | 'nodeId' | 'partitionKey' | 'uniqueKey' | 'uniqueForMs'>;

/** Job DOから見たRun DO, 通知だけを送る(ADR-0031) */
export interface RunStub extends Rpc.DurableObjectBranded {
	notify(events: readonly NodeEvent[]): Promise<void>;
}

/**
 * Run DOの外から見える面
 * 匿名クラスのまま推論させるとDurableObjectのprotectedが型定義に漏れて宣言を出力できない
 */
export interface TsumugiRunInstance extends Rpc.DurableObjectBranded {
	/** テストから差し替えるためpublicにしている */
	clock: Clock;
	start(input: StartInput): Promise<StartResult>;
	notify(events: readonly NodeEvent[]): Promise<void>;
	cancel(): Promise<MutationResult>;
	retry(): Promise<MutationResult>;
	alarm(): Promise<void>;
}

/** `createRunClass`が返すDOクラス, wranglerのclass_nameはこれをエクスポートした名前を指す */
export type RunClass = new (ctx: DurableObjectState, env: RunEnv) => TsumugiRunInstance;

export type RunOptions = {
	flows: Flows;
	bindings: Record<string, BindingConfig>;
	settings?: RunSettings;
};

/**
 * runの調停役(ADR-0029)
 *
 * 進行の判断は`core/run.ts`の純粋関数に委ね,ここはSQLiteとの橋渡しに徹する(ADR-0018)
 * flow定義は写像関数を含むのでDOには保存できず,クロージャで受けたコードから引く(ADR-0030)
 */
export function createRunClass({ flows, bindings, settings = {} }: RunOptions): RunClass {
	const maxNodes = settings.maxNodes ?? DEFAULT_MAX_NODES;
	const retention: Retention = {
		doneMs: settings.sweepAfterMs ?? DEFAULT_SWEEP_AFTER_MS,
		failedMs: settings.failedRetentionMs ?? DEFAULT_FAILED_RETENTION_MS,
	};
	const client = createClient<RunEnv>(bindings);

	return class TsumugiRun extends DurableObject<RunEnv> {
		/** テストから差し替えるためpublicにしている */
		clock: Clock = systemClock;

		#repo: RunRepo | undefined;
		/** tickが実行中か, 重なりを1本に絞るために持つ */
		#ticking = false;

		get repo(): RunRepo {
			if (!this.#repo) this.#repo = new RunRepo(this.ctx.storage);
			return this.#repo;
		}

		/** 自分がどのrunかは名前から読む, worker側が`idFromName(runId)`で引く(ADR-0029) */
		get runId(): string {
			return this.ctx.id.name ?? '';
		}

		/**
		 * runを開始する
		 * 同じrunIdは必ず同じDOに当たるので,二度目の開始をここで不可分に弾ける(ADR-0029)
		 */
		async start(input: StartInput): Promise<StartResult> {
			const now = this.clock.now();
			const runId = this.runId;
			const existing = this.repo.findRun();
			if (existing) return { id: runId, created: false };

			const flow = flows[input.flow];
			if (!flow) throw new Error(`flow is not registered: ${input.flow}`);

			const shape = shapeOf(flow);
			this.repo.insertRun({ id: runId, flow: input.flow, input: JSON.stringify(input.input ?? null), shape: JSON.stringify(shape), now });
			this.repo.insertNodes(
				shape.map((node, index) => ({
					id: node.id,
					binding: node.binding,
					container: node.container,
					parent: null,
					origin: 'static' as const,
					after: node.after,
					seq: index,
				})),
				now,
			);
			this.repo.appendRunOutbox();
			this.repo.appendNodeOutbox(
				runId,
				shape.map((node) => node.id),
			);
			await this.#armAlarm(now);
			return { id: runId, created: true };
		}

		/**
		 * Job DOからの完了通知(ADR-0031)
		 * 書くだけで返し,ノードの投入は自分のalarmで行う, DO間の呼び出しを入れ子にしないため
		 */
		async notify(events: readonly NodeEvent[]): Promise<void> {
			const now = this.clock.now();
			const runId = this.runId;
			// 削除後に届いた通知は破棄する, 再作成すると保持期間の指定が無意味になる
			if (!this.repo.findRun()) return;

			const touched: string[] = [];
			for (const event of events) {
				const row = this.repo.findNode(event.nodeId);
				// 再開でジョブが張り替わっているなら古い便, 適用すると再実行の結果を上書きする(ADR-0034)
				if (!row || row.job_id !== event.jobId) continue;

				// 子を先に作る, 親が決着してから作ると下流が子を待たずに実行される(ADR-0032)
				const spawned = this.#applySpawns(event.nodeId, event.spawns ?? [], now);
				touched.push(...spawned);

				this.repo.updateNode(event.nodeId, { state: event.state, result: event.result, error: event.error }, now);
				touched.push(event.nodeId);
			}

			if (touched.length > 0) {
				this.repo.appendNodeOutbox(runId, touched);
				await this.#armAlarm(now);
			}
		}

		/** 画面とREST APIからの取り消し, 未起動を止めて実行中の終端を待つ */
		async cancel(): Promise<MutationResult> {
			const now = this.clock.now();
			const row = this.repo.findRun();
			if (!row) return { ok: false, reason: 'gone' };
			if (row.state !== 'RUNNING') return { ok: false, reason: 'invalid-state' };
			this.repo.markCancelling(row.id, now);
			this.repo.appendRunOutbox();
			await this.#armAlarm(now);
			return { ok: true };
		}

		/** 失敗したノードから再開する(ADR-0034) */
		async retry(): Promise<MutationResult> {
			const now = this.clock.now();
			const row = this.repo.findRun();
			if (!row) return { ok: false, reason: 'gone' };
			if (row.state !== 'FAILED') return { ok: false, reason: 'invalid-state' };

			const reset = this.repo.resetForRetry(now);
			this.repo.setRunState(row.id, 'RUNNING', now);
			this.repo.appendRunOutbox();
			this.repo.appendNodeOutbox(row.id, reset);
			await this.#armAlarm(now);
			return { ok: true };
		}

		async alarm(): Promise<void> {
			try {
				await this.#tick();
			} catch (error) {
				// alarm()がthrowするとworkerdのリトライは6回で尽きる, 捕捉して必ず設定し直す
				console.error('tsumugi: run tick failed', error);
				await this.ctx.storage.setAlarm(this.clock.now() + 5_000);
			}
		}

		async #tick(): Promise<void> {
			// 重なって走ると同じノードに別のジョブIDを予約し得る, Job DOと違い状態の条件付き更新で守られていない
			// 手前で降りて予定だけ張り直す, 走っている方が終わってから改めて進める
			if (this.#ticking) {
				await this.#armAlarm(this.clock.now());
				return;
			}
			this.#ticking = true;
			try {
				await this.#advanceOnce();
			} finally {
				this.#ticking = false;
			}
		}

		async #advanceOnce(): Promise<void> {
			const now = this.clock.now();
			const runRow = this.repo.findRun();
			if (!runRow) return;

			const flow = flows[runRow.flow];
			if (!flow) {
				// 定義ごと消えた, 待っても解決しないので理由を残して落とす(ADR-0030)
				this.#failRun(runRow.id, `flow is not registered: ${runRow.flow}`, now);
				await this.#project();
				return;
			}

			const definitions = new Map(flow.nodes.map((node) => [node.id, node]));
			const runInput = JSON.parse(runRow.input) as unknown;
			const cancelling = runRow.cancelling === 1;

			const touched = new Set<string>();
			const inputs: EnqueueInput[] = [];
			const starting: string[] = [];
			// この tick で既に決めたノード, 投入はまとめて行うので判断済みでもPENDINGのまま残る
			const handled = new Set<string>();
			let deferred = 0;

			// 打ち切りの連鎖は1回のadvanceでは1段しか進まない, 進みが止まるまで回して1 tickで解く
			for (let round = 0; round < ADVANCE_ROUNDS; round++) {
				const output = advance({ nodes: this.repo.views(), cancelling });
				const fresh = output.decisions.filter((decision) => !handled.has(decision.id));
				if (fresh.length === 0) break;

				const room = TICK_LIMIT - handled.size;
				if (room <= 0) {
					deferred += fresh.length;
					break;
				}
				deferred += Math.max(0, fresh.length - room);

				for (const decision of fresh.slice(0, room)) {
					handled.add(decision.id);
					const applied = await this.#apply(decision, { definitions, runInput, runId: runRow.id, now, inputs, starting });
					for (const id of applied) touched.add(id);
				}
			}

			if (inputs.length > 0) {
				await client.enqueueMany(this.env, inputs);
				for (const id of starting) {
					this.repo.updateNode(id, { state: 'SCHEDULED' }, now);
					touched.add(id);
				}
			}

			// 決定を反映した後の姿で状態を決める, 反映前だと1tick古い状態を投影する
			const settled = advance({ nodes: this.repo.views(), cancelling });
			if (settled.state !== runRow.state) {
				this.repo.setRunState(runRow.id, settled.state, now);
				this.repo.appendRunOutbox();
			} else if (touched.size > 0) {
				// 進捗の集計が変わるのでrunも運ぶ
				this.repo.appendRunOutbox();
			}
			this.repo.appendNodeOutbox(runRow.id, [...touched]);

			const projected = await this.#project();
			if (await this.#sweep(now)) return;

			// 打ち切った決定と投影の残りがあるうちは休まない
			// 投影待ちも見る, tickのawait中に入った通知は投影されないまま残る
			const hasMore = deferred > 0 || projected >= PROJECTION_LIMIT || settled.decisions.length > 0 || this.repo.countOutbox() > 0;
			if (hasMore) await this.#armAlarm(now);
			else await this.#armSweep(now);
		}

		/** 決定を1つ反映し, 触れたノードIDを返す */
		async #apply(
			decision: RunDecision,
			context: {
				definitions: Map<string, FlowNode>;
				runInput: unknown;
				runId: string;
				now: number;
				inputs: EnqueueInput[];
				starting: string[];
			},
		): Promise<string[]> {
			const { definitions, runInput, runId, now, inputs, starting } = context;
			const row = this.repo.findNode(decision.id);
			if (!row) return [];

			switch (decision.type) {
				case 'start': {
					const built = this.#buildJob(row, definitions, runInput);
					if (!built) {
						this.repo.updateNode(row.id, { state: 'FAILED', error: `node definition is missing: ${row.id}` }, now);
						return [row.id];
					}
					// 先にジョブIDを確保する, 投入だけ成功して落ちても同じIDで再投入すれば二重にならない
					const jobId = row.job_id ?? formatJobId({ binding: row.binding, shard: this.#shardOf(row.binding, runId), localId: createId() });
					if (row.job_id === null) this.repo.updateNode(row.id, { jobId }, now);
					inputs.push({ ...built, id: jobId, binding: row.binding, runId, nodeId: row.id, partitionKey: runId });
					starting.push(row.id);
					return [row.id];
				}

				case 'expand':
					return this.#expand(row, definitions, runInput, now);

				case 'aggregate': {
					// fan-outノードはジョブを実行しないので, 子の成否の集計値が戻り値になる(ADR-0035)
					this.repo.updateNode(row.id, { state: 'COMPLETED', result: JSON.stringify(this.repo.childSummary(row.id)) }, now);
					return [row.id];
				}

				case 'skip':
					this.repo.updateNode(row.id, { state: 'SKIPPED' }, now);
					return [row.id];

				case 'cancel': {
					if (row.job_id === null || row.state === 'PENDING') {
						this.repo.updateNode(row.id, { state: 'CANCELLED' }, now);
						return [row.id];
					}
					// QUEUED以降は断られる, 断られたら通知を待つ(ADR-0012)
					const result = await this.#jobStub(row.job_id).cancel(row.job_id);
					if (!result.ok) return [];
					this.repo.updateNode(row.id, { state: 'CANCELLED' }, now);
					return [row.id];
				}
			}
		}

		/** fan-outの展開, 件数だけが実行時に決まる(ADR-0032) */
		#expand(row: NodeRow, definitions: Map<string, FlowNode>, runInput: unknown, now: number): string[] {
			const definition = definitions.get(row.id);
			if (!definition?.over || !definition.item) {
				this.repo.updateNode(row.id, { state: 'FAILED', error: `fan-out definition is missing: ${row.id}` }, now);
				return [row.id];
			}

			const items = definition.over(runInput, this.#depsOf(definition, runInput));
			if (this.repo.countNodes() + items.length > maxNodes) {
				this.repo.updateNode(row.id, { state: 'FAILED', error: `node count exceeded the limit: ${maxNodes}` }, now);
				return [row.id];
			}

			let seq = this.repo.nextSeq();
			const children = items.map((item, index) => {
				const key = definition.key ? definition.key(item, index) : String(index);
				assertNodeId(key);
				const concurrencyKey =
					typeof definition.childConcurrencyKey === 'function'
						? definition.childConcurrencyKey(item, index)
						: definition.childConcurrencyKey;
				return {
					id: `${row.id}:${key}`,
					binding: definition.binding,
					container: false,
					parent: row.id,
					origin: 'fanOut' as const,
					after: [],
					seq: seq++,
					payload: JSON.stringify(definition.item?.(item, runInput, index) ?? null),
					options: JSON.stringify({ ...definition.job, ...(concurrencyKey === undefined ? {} : { concurrencyKey }) }),
				};
			});

			this.repo.insertNodes(children, now);
			this.repo.updateNode(row.id, { state: 'RUNNING' }, now);
			return [row.id, ...children.map((child) => child.id)];
		}

		/** performの中で要求された子を作る, 同じIDの再要求は既存を残す(ADR-0032) */
		#applySpawns(parentId: string, spawns: readonly SpawnRequest[], now: number): string[] {
			if (spawns.length === 0) return [];
			if (this.repo.countNodes() + spawns.length > maxNodes) {
				this.repo.updateNode(parentId, { state: 'FAILED', error: `node count exceeded the limit: ${maxNodes}` }, now);
				return [parentId];
			}

			let seq = this.repo.nextSeq();
			const children = spawns.map((spawn) => {
				assertNodeId(spawn.id);
				const { concurrencyKey, ...job } = spawn.options ?? {};
				return {
					id: `${parentId}:${spawn.id}`,
					binding: spawn.binding,
					container: false,
					parent: parentId,
					origin: 'spawn' as const,
					after: [],
					seq: seq++,
					payload: JSON.stringify(spawn.payload ?? null),
					options: JSON.stringify({ ...job, ...(concurrencyKey === undefined ? {} : { concurrencyKey }) }),
				};
			});

			this.repo.insertNodes(children, now);
			return children.map((child) => child.id);
		}

		/**
		 * 投入するジョブの中身を組み立てる
		 * 実行時に増えたノードは確定済みの値を持ち,静的ノードはflow定義の写像関数から作る(ADR-0030)
		 */
		#buildJob(row: NodeRow, definitions: Map<string, FlowNode>, runInput: unknown): BuiltJob | null {
			if (row.payload !== null) {
				return { payload: JSON.parse(row.payload), ...(JSON.parse(row.options ?? '{}') as NodeJobOptions) };
			}

			const definition = definitions.get(row.id);
			if (!definition) return null;
			const deps = this.#depsOf(definition, runInput);
			const concurrencyKey =
				typeof definition.concurrencyKey === 'function' ? definition.concurrencyKey(runInput, deps) : definition.concurrencyKey;
			return {
				payload: definition.input(runInput, deps),
				...definition.job,
				...(concurrencyKey === undefined ? {} : { concurrencyKey }),
			};
		}

		/** 写像関数へ渡す受け取り口,`after`のキーをそのまま名前にする */
		#depsOf(definition: FlowNode, _runInput: unknown): Record<string, unknown> {
			const entries = Object.entries(definition.after);
			const results = this.repo.resultsOf(entries.map(([, id]) => id));
			return Object.fromEntries(entries.map(([name, id]) => [name, results.get(id)]));
		}

		#shardOf(binding: string, runId: string): number {
			// runIdをpartitionKeyにする, run内のノードが同じshardに集まりRun DO側でIDを決められる(ADR-0011)
			return resolveShard(binding, bindings[binding]?.shards ?? 1, runId);
		}

		#jobStub(jobId: string): DurableObjectStub<TsumugiJobShard> {
			const namespace = this.env.JOB_SHARD as DurableObjectNamespace<TsumugiJobShard>;
			return namespace.get(namespace.idFromName(shardNameOf(jobId)));
		}

		#failRun(runId: string, reason: string, now: number): void {
			const failed: string[] = [];
			for (const view of this.repo.views()) {
				if (view.state !== 'PENDING') continue;
				this.repo.updateNode(view.id, { state: 'FAILED', error: reason }, now);
				failed.push(view.id);
			}
			this.repo.setRunState(runId, 'FAILED', now);
			this.repo.appendRunOutbox();
			// ノードも運ぶ, 積まないと読み取りモデルのノードがPENDINGのまま残る
			this.repo.appendNodeOutbox(runId, failed);
		}

		/** アウトボックスをD1へ流す(ADR-0008) */
		async #project(): Promise<number> {
			const rows = this.repo.outboxBatch(PROJECTION_LIMIT);
			if (rows.length === 0) return 0;
			await projectRun(this.env.TSUMUGI_DB, rows);
			this.repo.deleteOutboxThrough(rows[rows.length - 1]!.seq);
			return rows.length;
		}

		/**
		 * 終端に達したrunを保持期間の経過後に削除する(ADR-0034)
		 * 投影が残っているうちは消さない, 消すと読み取りモデルが途中の状態で固まる
		 */
		async #sweep(now: number): Promise<boolean> {
			const row = this.repo.findRun();
			if (!row || row.state === 'RUNNING') return false;
			if (this.repo.countOutbox() > 0) return false;
			const keepFor = row.state === 'FAILED' ? retention.failedMs : retention.doneMs;
			if (row.updated_at + keepFor > now) return false;
			// SQLiteごと落とす, run 1件につき1インスタンスなので残す行が無い(ADR-0029)
			// 完了を待つ, 待たずに返すと削除の失敗が捨てられる
			await this.ctx.storage.deleteAll();
			return true;
		}

		/** 次に掃除の対象が出る時刻に起動する, 終端後に設定しないと削除の機会が来ない */
		async #armSweep(now: number): Promise<void> {
			const row = this.repo.findRun();
			if (!row || row.state === 'RUNNING') return;
			const keepFor = row.state === 'FAILED' ? retention.failedMs : retention.doneMs;
			// tickの実行中に張られたalarmを後ろへずらさない, ずらすと割り込んだ通知の処理が保持期間まで待たされる
			await this.#armAlarm(Math.max(row.updated_at + keepFor, now + 1_000));
		}

		/** 予定より早い時刻にalarmが張られている場合は上書きしない */
		async #armAlarm(at: number): Promise<void> {
			const current = await this.ctx.storage.getAlarm();
			if (current === null || current > at) await this.ctx.storage.setAlarm(at);
		}
	};
}

export type { AnyFlow, FlowShape, NodeState };
