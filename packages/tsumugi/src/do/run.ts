import { DurableObject } from 'cloudflare:workers';
import { createId } from '@paralleldrive/cuid2';
import type { BindingConfig, ClientEnv } from '../client/enqueue.js';
import { createClient } from '../client/enqueue.js';
import {
	assertDeadlineMs,
	assertNodeId,
	type AnyFlow,
	type FlowNode,
	type Flows,
	type FlowShape,
	type NodeJobOptions,
	shapeOf,
} from '../core/flow.js';
import { formatJobId, formatRunId, parseRunId, shardNameOf } from '../core/ids.js';
import {
	advance,
	isNodeTerminal,
	type NodeEvent,
	type NodeState,
	type RunDecision,
	type RunState,
	type SpawnRequest,
} from '../core/run.js';
import { resolveShard } from '../core/shard.js';
import type { Retention } from '../core/types.js';
import { systemClock, type Clock } from './clock.js';
import type { EnqueueInput, MutationResult, TsumugiJobShard } from './job-shard.js';
import { projectRun } from '../projection/run-projector.js';
import type { NodeRow } from './run-schema.js';
import { RunRepo } from './run-repo.js';

export type RunEnv = ClientEnv & {
	TSUMUGI_DB: D1Database;
	/** subflowを使う場合のみ必要, 子と親のrunを引く */
	RUN?: DurableObjectNamespace<any>;
};

/** 1回のtickで扱うノードの上限, alarmのwall timeを有界にする */
const TICK_LIMIT = 200;

/** 1回のtickで進行判断を回す上限, グラフの深さぶん回れば足りる */
const ADVANCE_ROUNDS = 32;

/** 1回の投影で流すアウトボックスの上限 */
const PROJECTION_LIMIT = 200;

/** 1つのrunに入るノード数の既定上限(ADR-0035) */
export const DEFAULT_MAX_NODES = 10_000;

/**
 * subflowの入れ子の既定上限
 * ノード数の上限は親と子で別々に数えるので, 深さ側にも上限が要る(ADR-0035)
 */
export const DEFAULT_MAX_DEPTH = 3;

/** 済んだrunをDOに残す時間,投影が追いつく余裕を見て既定5分(ADR-0034) */
const DEFAULT_SWEEP_AFTER_MS = 5 * 60 * 1000;

/** 失敗したrunをDOに残す時間, 再開を受け付ける期間(ADR-0034) */
const DEFAULT_FAILED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type RunSettings = {
	/** 1つのrunに入るノード数の上限(ADR-0035) */
	maxNodes?: number;
	/** subflowの入れ子の上限, 既定は3 */
	maxDepth?: number;
	/** 済んだrun(COMPLETED / CANCELLED)をDOに残す時間 */
	sweepAfterMs?: number;
	/** 失敗したrunをDOに残す時間, 手動再開を受け付ける期間 */
	failedRetentionMs?: number;
};

export type StartInput = {
	flow: string;
	input: unknown;
	/** run全体の期限(ms), 未指定はflow定義の値(ADR-0039) */
	deadlineMs?: number;
	/** subflowとして起動された場合の親, 終端に達した時点で知らせる先 */
	parent?: { runId: string; nodeId: string };
	/** 入れ子の深さ, 親から受け取る */
	depth?: number;
};
export type StartResult = { id: string; created: boolean };

/** 1 tickで開始する子のrun */
type SubflowStart = { nodeId: string; childRunId: string; flow: string; input: unknown };

/** ノード1件ぶんの投入内容, 宛先はRun DOが被せる */
type BuiltJob = Omit<EnqueueInput, 'binding' | 'id' | 'runId' | 'nodeId' | 'partitionKey' | 'uniqueKey' | 'uniqueForMs'>;

/** ノードのerror列へ入れる文言、stackは載せず理由だけを残す */
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Job DOから見たRun DO, 通知だけを送る(ADR-0031) */
export interface RunStub extends Rpc.DurableObjectBranded {
	notify(events: readonly NodeEvent[]): Promise<void>;
}

/**
 * 親と子の間で使うRun DOの面
 * DO本体の型を通すと型の展開が深くなりすぎるので, 使う分だけを宣言する
 */
export interface RunPeerStub extends Rpc.DurableObjectBranded {
	start(input: StartInput): Promise<StartResult>;
	cancel(): Promise<MutationResult>;
	notifyChild(nodeId: string, childRunId: string, state: RunState): Promise<void>;
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
	notifyChild(nodeId: string, childRunId: string, state: RunState): Promise<void>;
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
	const maxDepth = settings.maxDepth ?? DEFAULT_MAX_DEPTH;
	// flow定義から名前を引く, subflowノードは定義そのものを持つのでここで名前へ落とす
	const nameOf = (child: AnyFlow) => Object.keys(flows).find((name) => flows[name] === child);
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

			const depth = input.depth ?? 0;
			// 深さの判定は起動された側で行う, 親が上限を知らなくても入れ子が止まる
			if (depth > maxDepth) throw new Error(`subflow nesting exceeded the limit: ${maxDepth}`);

			// 期限はstartの指定を優先しflow定義を既定にする(ADR-0039)
			const deadlineMs = input.deadlineMs ?? flow.deadlineMs;
			if (deadlineMs !== undefined) assertDeadlineMs(deadlineMs);

			const shape = shapeOf(flow, nameOf);
			this.repo.insertRun({
				id: runId,
				flow: input.flow,
				input: JSON.stringify(input.input ?? null),
				shape: JSON.stringify(shape),
				now,
				parent: input.parent,
				depth,
				...(deadlineMs !== undefined ? { deadlineMs } : {}),
			});
			this.repo.insertNodes(
				shape.map((node, index) => ({
					id: node.id,
					binding: node.binding,
					container: node.container,
					parent: null,
					origin: 'static' as const,
					after: node.after,
					seq: index,
					...(node.subflow !== undefined ? { subflow: node.subflow } : {}),
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
				// 取り消しの便はRun DO自身が要求した結果の追認, 期限超過で先にFAILEDへ落ちたノードを上書きしない(ADR-0039)
				if (event.state === 'CANCELLED' && isNodeTerminal(row.state as NodeState)) continue;

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

		/**
		 * 子のrunからの終端の通知
		 * 子の状態をそのままノードの状態にする, 戻り値は受け取らない(ADR-0035)
		 */
		async notifyChild(nodeId: string, childRunId: string, state: RunState): Promise<void> {
			const now = this.clock.now();
			const run = this.repo.findRun();
			if (!run) return;

			const row = this.repo.findNode(nodeId);
			// 再開で子が張り替わっているなら古い便, 適用すると再実行の結果を上書きする(ADR-0034)
			if (!row || row.child_run_id !== childRunId || state === 'RUNNING') return;

			this.repo.updateNode(nodeId, { state, ...(state === 'FAILED' ? { error: `child run failed: ${childRunId}` } : {}) }, now);
			this.repo.appendNodeOutbox(run.id, [nodeId]);
			await this.#armAlarm(now);
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
			// 期限を引き直す, 元の時刻のままでは再開直後に再び超過する(ADR-0039)
			this.repo.resetDeadline(now);
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
			// 期限超過は取り消しと同じ排水で打ち切る(ADR-0039)
			const expired = runRow.deadline_at !== null && runRow.deadline_at <= now;
			// 打ち切られたノードへ残す理由, runには理由の置き場が無い, 取り消しはCANCELLEDのままにする
			const deadlineError = expired && !cancelling ? `run deadline exceeded: ${runRow.deadline_ms}ms` : null;

			const touched = new Set<string>();
			const inputs: EnqueueInput[] = [];
			const starting: string[] = [];
			const subflows: SubflowStart[] = [];
			// この tick で既に決めたノード, 投入はまとめて行うので判断済みでもPENDINGのまま残る
			const handled = new Set<string>();
			let deferred = 0;

			// 打ち切りの連鎖は1回のadvanceでは1段しか進まない, 進みが止まるまで回して1 tickで解く
			for (let round = 0; round < ADVANCE_ROUNDS; round++) {
				const output = advance({ nodes: this.repo.views(), cancelling, expired });
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
					const applied = await this.#apply(decision, {
						definitions,
						runInput,
						runId: runRow.id,
						now,
						inputs,
						starting,
						subflows,
						deadlineError,
					});
					for (const id of applied) touched.add(id);
				}
			}

			if (inputs.length > 0) {
				await client.enqueueMany(this.env, inputs);
			}
			// 子のrunは同じIDで二度開始しても既存を返すので, 落ちた後の再実行で増えない(ADR-0029)
			const unstarted = new Set<string>();
			for (const child of subflows) {
				try {
					await this.#runStub(child.childRunId).start({
						flow: child.flow,
						input: child.input,
						parent: { runId: runRow.id, nodeId: child.nodeId },
						depth: runRow.depth + 1,
					});
				} catch (error) {
					// 入れ子の上限超過などは待っても解決しない、落とさないとtickが同じ失敗を繰り返す
					this.repo.updateNode(child.nodeId, { state: 'FAILED', error: `failed to start child run: ${messageOf(error)}` }, now);
					unstarted.add(child.nodeId);
					touched.add(child.nodeId);
				}
			}
			for (const id of starting) {
				if (unstarted.has(id)) continue;
				// subflowノードは子の終端を待つ, ジョブと違いSCHEDULEDを経ない
				this.repo.updateNode(id, { state: subflows.some((child) => child.nodeId === id) ? 'RUNNING' : 'SCHEDULED' }, now);
				touched.add(id);
			}

			// 決定を反映した後の姿で状態を決める, 反映前だと1tick古い状態を投影する
			const settled = advance({ nodes: this.repo.views(), cancelling, expired });
			if (settled.state !== runRow.state) {
				this.repo.setRunState(runRow.id, settled.state, now);
				this.repo.appendRunOutbox();
			} else if (touched.size > 0) {
				// 進捗の集計が変わるのでrunも運ぶ
				this.repo.appendRunOutbox();
			}
			this.repo.appendNodeOutbox(runRow.id, [...touched]);

			const projected = await this.#project();
			const notified = await this.#notifyParent(settled.state, now);
			if (notified && (await this.#sweep(now))) return;

			// 打ち切った決定と投影の残りがあるうちは休まない
			// 投影待ちも見る, tickのawait中に入った通知は投影されないまま残る
			const hasMore =
				deferred > 0 || projected >= PROJECTION_LIMIT || settled.decisions.length > 0 || this.repo.countOutbox() > 0 || !notified;
			if (hasMore) await this.#armAlarm(now);
			else if (settled.state === 'RUNNING') await this.#armDeadline(now);
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
				subflows: SubflowStart[];
				/** 期限超過による打ち切りの理由, 取り消しではnull(ADR-0039) */
				deadlineError: string | null;
			},
		): Promise<string[]> {
			const { definitions, runInput, runId, now, inputs, starting, subflows, deadlineError } = context;
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

				case 'startRun': {
					const definition = definitions.get(row.id);
					if (!definition?.subflow || row.subflow === null) {
						this.repo.updateNode(row.id, { state: 'FAILED', error: `subflow definition is missing: ${row.id}` }, now);
						return [row.id];
					}
					// 子のrunIdは親のrunIdとノードIDから決まる, 再送しても同じ子に当たる(ADR-0029)
					let childRunId: string;
					try {
						childRunId = formatRunId({ flow: row.subflow, localId: `${parseRunId(runId).localId}-${row.id}` });
					} catch (error) {
						// flow名が形として使えない、待っても解決しない
						this.repo.updateNode(row.id, { state: 'FAILED', error: `invalid child run id: ${messageOf(error)}` }, now);
						return [row.id];
					}
					if (row.child_run_id === null) this.repo.updateNode(row.id, { childRunId }, now);
					starting.push(row.id);
					subflows.push({
						nodeId: row.id,
						childRunId,
						flow: row.subflow,
						input: definition.input(runInput, this.#depsOf(definition, runInput)),
					});
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
					// 期限超過の打ち切りは理由付きのFAILEDにする, 取り消しはCANCELLEDのまま(ADR-0039)
					const terminal =
						deadlineError !== null ? ({ state: 'FAILED', error: deadlineError } as const) : ({ state: 'CANCELLED' } as const);
					if (row.child_run_id !== null) {
						// 子のcancelは要求の受理までで、終端に達したかは子からの通知で決まる
						await this.#runStub(row.child_run_id).cancel();
						return [];
					}
					if (row.job_id === null || row.state === 'PENDING') {
						this.repo.updateNode(row.id, terminal, now);
						return [row.id];
					}
					// QUEUED以降は断られる, 断られたら通知を待つ(ADR-0012)
					const result = await this.#jobStub(row.job_id).cancel(row.job_id);
					if (!result.ok) return [];
					this.repo.updateNode(row.id, terminal, now);
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

		/**
		 * 終端に達したことを親のrunへ知らせる
		 * 送信に失敗した場合は印を立てずに次のtickで再送する
		 * 親を持たないrunと未達のrunはtrueを返す, 掃除を止める理由が無い
		 */
		async #notifyParent(state: RunState, now: number): Promise<boolean> {
			const row = this.repo.findRun();
			if (!row || row.parent_run_id === null || row.parent_node_id === null) return true;
			if (state === 'RUNNING') return true;
			if (row.parent_notified === 1) return true;

			try {
				await this.#runStub(row.parent_run_id).notifyChild(row.parent_node_id, row.id, state);
			} catch (error) {
				console.error('tsumugi: notifyParent failed', error);
				return false;
			}
			this.repo.markParentNotified(row.id, now);
			return true;
		}

		#runStub(runId: string): DurableObjectStub<RunPeerStub> {
			const namespace = this.env.RUN as DurableObjectNamespace<RunPeerStub> | undefined;
			if (!namespace) throw new Error('RUN binding is not configured, add the Run DO binding to wrangler');
			return namespace.get(namespace.idFromName(runId));
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

		/**
		 * 期限の時刻に起動する(ADR-0039)
		 * 進みの止まったrunはalarmを持たないので, 張らないと超過を判定する機会が来ない
		 * 超過後は張らない, 実行中の終端は通知が運んでくる
		 */
		async #armDeadline(now: number): Promise<void> {
			const row = this.repo.findRun();
			if (!row || row.deadline_at === null || row.deadline_at <= now) return;
			await this.#armAlarm(row.deadline_at);
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
