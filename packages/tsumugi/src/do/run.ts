import { DurableObject } from 'cloudflare:workers';
import { createId } from '@paralleldrive/cuid2';
import type { BindingConfig, ClientEnv } from '../client/enqueue.js';
import { configOf, createClient } from '../client/enqueue.js';
import {
	assertDeadlineMs,
	assertNodeId,
	isNodeId,
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
	/** subflowを使う場合のみ必要, 子と親のrunの参照用 */
	RUN?: DurableObjectNamespace<any>;
};

/** 1回のtickで扱うノードの上限, alarmのwall timeを有界に維持 */
const TICK_LIMIT = 200;

/** 1回のtickでの進行判断の反復上限, グラフの深さぶんの反復で十分 */
const ADVANCE_ROUNDS = 32;

/** 1回の投影で処理するアウトボックスの上限 */
const PROJECTION_LIMIT = 200;

/** 1つのrunに入るノード数の既定上限(ADR-0035) */
export const DEFAULT_MAX_NODES = 10_000;

/**
 * subflowの入れ子の既定上限
 * ノード数の上限は親と子で別々の集計, 深さ側にも上限が必要(ADR-0035)
 */
export const DEFAULT_MAX_DEPTH = 3;

/** 済んだrunをDOに残す時間, 投影が追いつく余裕を考慮し既定5分(ADR-0034) */
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

/** ノード1件ぶんの投入内容, 宛先はRun DOが付与 */
type BuiltJob = Omit<EnqueueInput, 'binding' | 'id' | 'runId' | 'nodeId' | 'partitionKey' | 'uniqueKey' | 'uniqueForMs'>;

/** ノードのerror列へ入れる文言, stackは含めず理由だけを保存 */
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Job DOから見たRun DO, 通知の送信のみ(ADR-0031) */
export interface RunStub extends Rpc.DurableObjectBranded {
	notify(events: readonly NodeEvent[]): Promise<void>;
}

/**
 * 親と子の間で使うRun DOの面
 * DO本体の型を使うと型の展開が過剰に深く、使う分だけを宣言
 */
export interface RunPeerStub extends Rpc.DurableObjectBranded {
	start(input: StartInput): Promise<StartResult>;
	cancel(): Promise<MutationResult>;
	notifyChild(nodeId: string, childRunId: string, state: RunState): Promise<void>;
}

/**
 * Run DOの外から見える面
 * 匿名クラスのまま推論させるとDurableObjectのprotectedが型定義に混入し宣言を出力不能
 */
export interface TsumugiRunInstance extends Rpc.DurableObjectBranded {
	/** テストからの差し替え用にpublic */
	clock: Clock;
	start(input: StartInput): Promise<StartResult>;
	notify(events: readonly NodeEvent[]): Promise<void>;
	notifyChild(nodeId: string, childRunId: string, state: RunState): Promise<void>;
	cancel(): Promise<MutationResult>;
	retry(): Promise<MutationResult>;
	state(): Promise<RunState | null>;
	alarm(): Promise<void>;
}

/** `createRunClass`が返すDOクラス, wranglerのclass_nameはこれをエクスポートした名前を指す */
export type RunClass = new (ctx: DurableObjectState, env: RunEnv) => TsumugiRunInstance;

export type RunOptions = {
	flows: Flows;
	bindings: Record<string, BindingConfig>;
	settings?: RunSettings;
	/** 失敗を知らせる先のbinding(#30), ノードとして投入するジョブにも同じ宛先が必要 */
	failureBinding?: string | null;
};

/**
 * runの調停役(ADR-0029)
 *
 * 進行の判断は`core/run.ts`の純粋関数が担当、ここはSQLiteとの仲介のみ(ADR-0018)
 * flow定義は写像関数を含みDOへ保存不可、クロージャで受けたコードから取得(ADR-0030)
 */
export function createRunClass({ flows, bindings, settings = {}, failureBinding }: RunOptions): RunClass {
	const maxNodes = settings.maxNodes ?? DEFAULT_MAX_NODES;
	const maxDepth = settings.maxDepth ?? DEFAULT_MAX_DEPTH;
	// flow定義から名前を取得, subflowノードは定義そのものを持ちここで名前へ変換
	const nameOf = (child: AnyFlow) => Object.keys(flows).find((name) => flows[name] === child);
	const retention: Retention = {
		doneMs: settings.sweepAfterMs ?? DEFAULT_SWEEP_AFTER_MS,
		failedMs: settings.failedRetentionMs ?? DEFAULT_FAILED_RETENTION_MS,
	};
	const client = createClient<RunEnv>(bindings, failureBinding === undefined ? {} : { failureBinding });

	return class TsumugiRun extends DurableObject<RunEnv> {
		/** テストからの差し替え用にpublic */
		clock: Clock = systemClock;

		#repo: RunRepo | undefined;
		/** tickが実行中か, 同時実行を1つに制限するためのフラグ */
		#ticking = false;

		get repo(): RunRepo {
			if (!this.#repo) this.#repo = new RunRepo(this.ctx.storage);
			return this.#repo;
		}

		/** 自分がどのrunかは名前から読む, worker側は`idFromName(runId)`で参照(ADR-0029) */
		get runId(): string {
			return this.ctx.id.name ?? '';
		}

		/**
		 * runの開始
		 * 同じrunIdは必ず同じDOに対応し、二度目の開始をここで不可分に拒否可能(ADR-0029)
		 */
		async start(input: StartInput): Promise<StartResult> {
			const now = this.clock.now();
			const runId = this.runId;
			const existing = this.repo.findRun();
			if (existing) return { id: runId, created: false };

			const flow = Object.hasOwn(flows, input.flow) ? flows[input.flow] : undefined;
			if (!flow) throw new Error(`flow is not registered: ${input.flow}`);

			const depth = input.depth ?? 0;
			// 深さの判定は起動された側で実施, 親が上限を持たなくても入れ子が停止
			if (depth > maxDepth) throw new Error(`subflow nesting exceeded the limit: ${maxDepth}`);

			// 期限はstartの指定を優先しflow定義が既定(ADR-0039)
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
					trigger: node.trigger,
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
		 * 書くだけで返し、ノードの投入は自分のalarmで実施, DO間の呼び出しの入れ子を回避
		 */
		async notify(events: readonly NodeEvent[]): Promise<void> {
			const now = this.clock.now();
			const runId = this.runId;
			// 削除後に届いた通知は破棄, 再作成では保持期間の指定が無意味
			if (!this.repo.findRun()) return;

			const touched: string[] = [];
			for (const event of events) {
				const row = this.repo.findNode(event.nodeId);
				// 再開でジョブが差し替わっているなら古い通知, 適用すると再実行の結果を上書き(ADR-0034)
				if (!row || row.job_id !== event.jobId) continue;
				// 取り消しの通知はRun DO自身が要求した結果の追認, 期限超過で先にFAILEDへ遷移したノードは上書きなし(ADR-0039)
				if (event.state === 'CANCELLED' && isNodeTerminal(row.state as NodeState)) continue;

				// 子を先に作成, 親の決着後の作成では下流が子を待たずに実行(ADR-0032)
				const spawned = this.#applySpawns(event.nodeId, event.spawns ?? [], now);
				touched.push(...spawned.ids);

				// 子を作成できない場合は親を非成功, 成功では下流が子を待たずに実行
				this.repo.updateNode(
					event.nodeId,
					spawned.error === null
						? { state: event.state, result: event.result, error: event.error }
						: { state: 'FAILED', error: spawned.error },
					now,
				);
				touched.push(event.nodeId);
			}

			if (touched.length > 0) {
				this.repo.appendNodeOutbox(runId, touched);
				await this.#armAlarm(now);
			}
		}

		/**
		 * 子のrunからの終端の通知
		 * 子の状態をそのままノードの状態へ反映, 戻り値は対象外(ADR-0035)
		 */
		async notifyChild(nodeId: string, childRunId: string, state: RunState): Promise<void> {
			const now = this.clock.now();
			const run = this.repo.findRun();
			if (!run) return;

			const row = this.repo.findNode(nodeId);
			// 再開で子が差し替わっているなら古い通知, 適用すると再実行の結果を上書き(ADR-0034)
			if (!row || row.child_run_id !== childRunId || state === 'RUNNING') return;

			this.repo.updateNode(nodeId, { state, ...(state === 'FAILED' ? { error: `child run failed: ${childRunId}` } : {}) }, now);
			this.repo.appendNodeOutbox(run.id, [nodeId]);
			await this.#armAlarm(now);
		}

		/**
		 * scheduleのskip判定のための読み取り, 削除済みはnull(ADR-0040)
		 * 削除後の照会は空のDOを再生成するが、行もalarmも無く無害
		 */
		async state(): Promise<RunState | null> {
			return (this.repo.findRun()?.state as RunState | undefined) ?? null;
		}

		/** 画面とREST APIからの取り消し, 未起動を停止して実行中の終端を待機 */
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

		/** 失敗したノードからの再開(ADR-0034) */
		async retry(): Promise<MutationResult> {
			const now = this.clock.now();
			const row = this.repo.findRun();
			if (!row) return { ok: false, reason: 'gone' };
			if (row.state !== 'FAILED') return { ok: false, reason: 'invalid-state' };

			const reset = this.repo.resetForRetry(now);
			// 期限を再計算し超過の印を解除, 元のままでは再開直後に再び超過(ADR-0039)
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
				// alarm()がthrowするとworkerdのリトライは6回で枯渇, 捕捉して必ず再設定
				console.error('tsumugi: run tick failed', error);
				await this.ctx.storage.setAlarm(this.clock.now() + 5_000);
			}
		}

		async #tick(): Promise<void> {
			// 同時実行では同じノードに別のジョブIDを予約し得る, Job DOと違い状態の条件付き更新の保護が無い
			// ここで終了し予定だけ再設定, 実行中の側の終了後に改めて進行
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

			const flow = Object.hasOwn(flows, runRow.flow) ? flows[runRow.flow] : undefined;
			if (!flow) {
				// 定義ごと消えた場合は待機で解決せず, 理由を残してFAILEDへ(ADR-0030)
				this.#failRun(runRow.id, `flow is not registered: ${runRow.flow}`, now);
				await this.#project();
				return;
			}

			const definitions = new Map(flow.nodes.map((node) => [node.id, node]));
			const runInput = JSON.parse(runRow.input) as unknown;
			const cancelling = runRow.cancelling === 1;
			// 期限超過は取り消しと同じ手順で中断(ADR-0039)
			// 印はRUNNINGの間に一度だけ設定して永続化, 時計からの毎tick判定は決着済みのrunが削除のtickでFAILEDへ反転
			let expired = runRow.expired === 1;
			if (!expired && runRow.state === 'RUNNING' && runRow.deadline_at !== null && runRow.deadline_at <= now) {
				this.repo.markExpired(runRow.id, now);
				expired = true;
			}
			// 中断されたノードへ残す理由, runには理由の置き場が無い, 取り消しはCANCELLEDのまま
			const deadlineError = expired && !cancelling ? `run deadline exceeded: ${runRow.deadline_ms}ms` : null;

			const touched = new Set<string>();
			const inputs: EnqueueInput[] = [];
			const starting: string[] = [];
			const subflows: SubflowStart[] = [];
			// このtickで既に決めたノード, 投入はまとめて行い判断済みでもPENDINGのまま残る
			const handled = new Set<string>();
			let deferred = 0;

			// 中断の連鎖は1回のadvanceでは1段しか進まない, 進みが止まるまで反復して1 tickで解決
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
			// 子のrunは同じIDの二度目の開始で既存を返し、中断後の再実行でも増えない(ADR-0029)
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
					// 入れ子の上限超過等は待機では解決しない, FAILEDへ進めないとtickが同じ失敗を反復
					this.repo.updateNode(child.nodeId, { state: 'FAILED', error: `failed to start child run: ${messageOf(error)}` }, now);
					unstarted.add(child.nodeId);
					touched.add(child.nodeId);
				}
			}
			for (const id of starting) {
				if (unstarted.has(id)) continue;
				const current = this.repo.findNode(id);
				// 投入を待つ間に完了通知が入り得る, 終端に達したノードを起動中へ戻すと以後の通知が無い
				if (!current || isNodeTerminal(current.state as NodeState)) continue;
				// subflowノードは子の終端を待機, ジョブと違いSCHEDULEDを経ない
				this.repo.updateNode(id, { state: subflows.some((child) => child.nodeId === id) ? 'RUNNING' : 'SCHEDULED' }, now);
				touched.add(id);
			}

			// 決定を反映した後の内容で状態を決定, 反映前では1tick古い状態を投影
			const settled = advance({ nodes: this.repo.views(), cancelling, expired });
			if (settled.state !== runRow.state) {
				this.repo.setRunState(runRow.id, settled.state, now);
				this.repo.appendRunOutbox();
			} else if (touched.size > 0) {
				// 進捗の集計が変わりrunも投影対象
				this.repo.appendRunOutbox();
			}
			this.repo.appendNodeOutbox(runRow.id, [...touched]);

			const projected = await this.#project();
			const notified = await this.#notifyParent(settled.state, now);
			if (notified && (await this.#sweep(now))) return;

			// 中断の決定と投影の残りがあるうちは即座に再実行
			// 投影待ちも確認, tickのawait中に入った通知は投影されないまま残る
			const hasMore =
				deferred > 0 || projected >= PROJECTION_LIMIT || settled.decisions.length > 0 || this.repo.countOutbox() > 0 || !notified;
			if (hasMore) await this.#armAlarm(now);
			else if (settled.state === 'RUNNING') await this.#armDeadline(now);
			else await this.#armSweep(now);
		}

		/** 決定を1つ反映し、変更したノードIDを返す */
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
				/** 期限超過による中断の理由, 取り消しではnull(ADR-0039) */
				deadlineError: string | null;
			},
		): Promise<string[]> {
			const { definitions, runInput, runId, now, inputs, starting, subflows, deadlineError } = context;
			const row = this.repo.findNode(decision.id);
			if (!row) return [];

			// 起動の直前に判定, 依存の戻り値が揃うのはこの時点(ADR-0041)
			if (decision.type === 'start' || decision.type === 'startRun' || decision.type === 'expand') {
				const gate = this.#gate(row, definitions, runInput, now);
				if (gate !== null) return gate;
			}

			switch (decision.type) {
				case 'start': {
					const evaluated = this.#evaluate(row, 'input', now, () => this.#buildJob(row, definitions, runInput));
					if (!evaluated.ok) return [row.id];
					const built = evaluated.value;
					if (!built) {
						this.repo.updateNode(row.id, { state: 'FAILED', error: `node definition is missing: ${row.id}` }, now);
						return [row.id];
					}
					// 先にジョブIDを確保, 投入だけ成功して中断しても同じIDの再投入で二重化なし
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
					// 子のrunIdは親のrunIdとノードIDから確定, 再送でも同じ子に到達(ADR-0029)
					let childRunId: string;
					try {
						childRunId = formatRunId({ flow: row.subflow, localId: `${parseRunId(runId).localId}-${row.id}` });
					} catch (error) {
						// flow名が形として使用不可, 待機では解決なし
						this.repo.updateNode(row.id, { state: 'FAILED', error: `invalid child run id: ${messageOf(error)}` }, now);
						return [row.id];
					}
					// 子の入力は状態の更新前に構築, 失敗時の起動中ノードの残存を防止
					const input = this.#evaluate(row, 'input', now, () => definition.input(runInput, this.#depsOf(definition, runInput)));
					if (!input.ok) return [row.id];

					if (row.child_run_id === null) this.repo.updateNode(row.id, { childRunId }, now);
					starting.push(row.id);
					subflows.push({ nodeId: row.id, childRunId, flow: row.subflow, input: input.value });
					return [row.id];
				}

				case 'expand':
					return this.#expand(row, definitions, runInput, now);

				case 'aggregate': {
					// fan-outノード自体はジョブを実行せず、子の成否の集計値が戻り値(ADR-0035)
					this.repo.updateNode(row.id, { state: 'COMPLETED', result: JSON.stringify(this.repo.childSummary(row.id)) }, now);
					return [row.id];
				}

				case 'skip':
					// 不実行の理由は状態から判別不能, 画面で確認できるよう理由を保存(ADR-0041)
					this.repo.updateNode(row.id, { state: 'SKIPPED', error: decision.reason }, now);
					return [row.id];

				case 'cancel': {
					// 期限超過の中断は理由付きのFAILED, 取り消しはCANCELLEDのまま(ADR-0039)
					const terminal =
						deadlineError !== null ? ({ state: 'FAILED', error: deadlineError } as const) : ({ state: 'CANCELLED' } as const);
					if (row.child_run_id !== null) {
						// 子のcancelは要求の受理までで、終端に達したかは子からの通知で確定
						await this.#runStub(row.child_run_id).cancel();
						return [];
					}
					if (row.job_id === null || row.state === 'PENDING') {
						this.repo.updateNode(row.id, terminal, now);
						return [row.id];
					}
					// QUEUED以降は拒否される, 拒否後は通知を待機(ADR-0012)
					const result = await this.#jobStub(row.job_id).cancel(row.job_id);
					if (!result.ok) return [];
					this.repo.updateNode(row.id, terminal, now);
					return [row.id];
				}
			}
		}

		/** fan-outの展開, 件数だけが実行時に確定(ADR-0032) */
		#expand(row: NodeRow, definitions: Map<string, FlowNode>, runInput: unknown, now: number): string[] {
			const definition = definitions.get(row.id);
			if (!definition?.over || !definition.item) {
				this.repo.updateNode(row.id, { state: 'FAILED', error: `fan-out definition is missing: ${row.id}` }, now);
				return [row.id];
			}

			const items = this.#evaluate(row, 'over', now, () => definition.over!(runInput, this.#depsOf(definition, runInput)));
			if (!items.ok) return [row.id];
			if (this.repo.countNodes() + items.value.length > maxNodes) {
				this.repo.updateNode(row.id, { state: 'FAILED', error: `node count exceeded the limit: ${maxNodes}` }, now);
				return [row.id];
			}

			let seq = this.repo.nextSeq();
			const built = this.#evaluate(row, 'fan-out', now, () =>
				items.value.map((item, index) => {
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
				}),
			);
			if (!built.ok) return [row.id];
			const children = built.value;

			this.repo.insertNodes(children, now);
			this.repo.updateNode(row.id, { state: 'RUNNING' }, now);
			return [row.id, ...children.map((child) => child.id)];
		}

		/**
		 * performの中で要求された子の作成, 同じIDの再要求は既存を維持(ADR-0032)
		 * 作成できない場合は例外ではなく理由を返す, 例外では通知が滞留
		 */
		#applySpawns(parentId: string, spawns: readonly SpawnRequest[], now: number): { ids: string[]; error: string | null } {
			if (spawns.length === 0) return { ids: [], error: null };
			if (this.repo.countNodes() + spawns.length > maxNodes) {
				return { ids: [], error: `node count exceeded the limit: ${maxNodes}` };
			}
			const invalid = spawns.find((spawn) => !isNodeId(spawn.id));
			if (invalid) return { ids: [], error: `invalid spawn id: ${JSON.stringify(invalid.id)}` };

			let seq = this.repo.nextSeq();
			const children = spawns.map((spawn) => {
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
			return { ids: children.map((child) => child.id), error: null };
		}

		/**
		 * 投入するジョブの内容の構築
		 * 実行時に増えたノードは確定済みの値を持ち、静的ノードはflow定義の写像関数から作成(ADR-0030)
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

		// 失敗はノードのFAILEDへ変換, 例外のままではtickが毎回同じ位置で停止
		#evaluate<T>(row: NodeRow, label: string, now: number, run: () => T): { ok: true; value: T } | { ok: false } {
			try {
				return { ok: true, value: run() };
			} catch (error) {
				this.repo.updateNode(row.id, { state: 'FAILED', error: `${label} failed: ${messageOf(error)}` }, now);
				return { ok: false };
			}
		}

		/**
		 * `when`の判定(ADR-0041)
		 * 実行してよければnull, 実行しないなら該当ノードIDを返す
		 */
		#gate(row: NodeRow, definitions: Map<string, FlowNode>, runInput: unknown, now: number): string[] | null {
			const definition = definitions.get(row.id);
			if (!definition?.when) return null;

			const passed = this.#evaluate(row, 'when', now, () => definition.when!(runInput, this.#depsOf(definition, runInput)));
			if (!passed.ok) return [row.id];
			if (passed.value) return null;

			this.repo.updateNode(row.id, { state: 'SKIPPED', error: 'when returned false' }, now);
			return [row.id];
		}

		/** 写像関数へ渡す受け取り口, `after`のキーがそのまま名前 */
		#depsOf(definition: FlowNode, _runInput: unknown): Record<string, unknown> {
			const entries = Object.entries(definition.after);
			const results = this.repo.resultsOf(entries.map(([, id]) => id));
			return Object.fromEntries(entries.map(([name, id]) => [name, results.get(id)]));
		}

		#shardOf(binding: string, runId: string): number {
			// runIdをpartitionKeyに使用, run内のノードが同じshardに集約されRun DO側でIDを決定可能(ADR-0011)
			return resolveShard(binding, configOf(bindings, binding)?.shards ?? 1, runId);
		}

		/**
		 * 終端に達したことを親のrunへ通知
		 * 送信に失敗した場合は印を設定せず次のtickで再送
		 * 親を持たないrunと未達のrunはtrueを返す, 削除を止める理由が無い
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
			// ノードも投影, 対象に含めないと読み取りモデルのノードがPENDINGのまま残る
			this.repo.appendNodeOutbox(runId, failed);
		}

		/** アウトボックスをD1へ転送(ADR-0008) */
		async #project(): Promise<number> {
			const rows = this.repo.outboxBatch(PROJECTION_LIMIT);
			if (rows.length === 0) return 0;
			await projectRun(this.env.TSUMUGI_DB, rows);
			this.repo.deleteOutboxThrough(rows[rows.length - 1]!.seq);
			return rows.length;
		}

		/**
		 * 終端に達したrunを保持期間の経過後に削除(ADR-0034)
		 * 投影が残っているうちは削除しない, 削除すると読み取りモデルが途中の状態のまま残存
		 */
		async #sweep(now: number): Promise<boolean> {
			const row = this.repo.findRun();
			if (!row || row.state === 'RUNNING') return false;
			if (this.repo.countOutbox() > 0) return false;
			const keepFor = row.state === 'FAILED' ? retention.failedMs : retention.doneMs;
			if (row.updated_at + keepFor > now) return false;
			// SQLiteごと削除, run 1件につき1インスタンスで残す行が無い(ADR-0029)
			// 完了を待機, 待たずに返すと削除の失敗が検知不能
			await this.ctx.storage.deleteAll();
			return true;
		}

		/**
		 * 期限の時刻に起動(ADR-0039)
		 * 進みの止まったrunはalarmを持たず、設定しないと超過を判定する機会が無い
		 * 超過後は設定しない, 実行中の終端は通知で届く
		 */
		async #armDeadline(now: number): Promise<void> {
			const row = this.repo.findRun();
			if (!row || row.deadline_at === null || row.deadline_at <= now) return;
			await this.#armAlarm(row.deadline_at);
		}

		/** 次に削除の対象が出る時刻に起動, 終端後に設定しないと削除の機会が無い */
		async #armSweep(now: number): Promise<void> {
			const row = this.repo.findRun();
			if (!row || row.state === 'RUNNING') return;
			const keepFor = row.state === 'FAILED' ? retention.failedMs : retention.doneMs;
			// tickの実行中に設定されたalarmを後ろへずらさない, ずらすと割り込んだ通知の処理が保持期間まで遅延
			await this.#armAlarm(Math.max(row.updated_at + keepFor, now + 1_000));
		}

		/** 予定より早い時刻のalarmがある場合は上書きなし */
		async #armAlarm(at: number): Promise<void> {
			const current = await this.ctx.storage.getAlarm();
			if (current === null || current > at) await this.ctx.storage.setAlarm(at);
		}
	};
}

export type { AnyFlow, FlowShape, NodeState };
