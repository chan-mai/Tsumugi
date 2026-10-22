import { DurableObject } from 'cloudflare:workers';
import { createId } from '@paralleldrive/cuid2';
import type { BindingConfig, ClientEnv, EnqueueHook } from '../client/enqueue.js';
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
import type { Retention, SettledTarget } from '../core/types.js';
import { systemClock, type Clock } from './clock.js';
import type { EnqueueInput, MutationResult, TsumugiJobShard } from './job-shard.js';
import { projectRun } from '../projection/run-projector.js';
import type { NodeRow } from './run-schema.js';
import { deadlineErrorOf, RunRepo } from './run-repo.js';

export type RunEnv = ClientEnv & {
	TSUMUGI_DB: D1Database;
	/** subflow使用時のみ必要 */
	RUN?: DurableObjectNamespace<any>;
};

// alarmのwall time制限
const TICK_LIMIT = 200;

// グラフの深さ分で十分
const ADVANCE_ROUNDS = 32;

const PROJECTION_LIMIT = 200;

const NOTIFY_RETRY_MS = 5_000;

/** 1つのrunに入るノード数の既定上限(ADR-0035) */
export const DEFAULT_MAX_NODES = 10_000;

// ノード数上限は親子別集計(ADR-0035)
export const DEFAULT_MAX_DEPTH = 3;

// 投影完了の猶予(ADR-0034)
const DEFAULT_SWEEP_AFTER_MS = 5 * 60 * 1000;

// 再開受付期間(ADR-0034)
export const DEFAULT_RUN_FAILED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type RunSettings = {
	/** 1つのrunに入るノード数の上限(ADR-0035) */
	maxNodes?: number;
	/** subflowの入れ子の上限, 既定は3 */
	maxDepth?: number;
	/** COMPLETED / CANCELLEDのrunのDO保持時間 */
	sweepAfterMs?: number;
	/** 失敗runのDO保持時間, 手動再開の受付期間 */
	failedRetentionMs?: number;
};

export type StartInput = {
	flow: string;
	input: unknown;
	/** run全体の期限(ms), 未指定はflow定義の値(ADR-0039) */
	deadlineMs?: number;
	/** subflow起動時の親, 終端到達時の通知先 */
	parent?: { runId: string; nodeId: string };
	/** 入れ子の深さ, 親から指定 */
	depth?: number;
};
export type StartResult = { id: string; created: boolean };

type SubflowStart = { nodeId: string; childRunId: string; flow: string; input: unknown };

type BuiltJob = Omit<EnqueueInput, 'binding' | 'id' | 'runId' | 'nodeId' | 'partitionKey' | 'uniqueKey' | 'uniqueForMs'>;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Job DO用のRun DOインタフェース, 通知送信のみ(ADR-0031) */
export interface RunStub extends Rpc.DurableObjectBranded {
	notify(events: readonly NodeEvent[]): Promise<void>;
}

// 型展開過多の回避で使用分のみ宣言
export interface RunPeerStub extends Rpc.DurableObjectBranded {
	start(input: StartInput): Promise<StartResult>;
	state(): Promise<RunState | null>;
	cancel(): Promise<MutationResult>;
	retry(): Promise<MutationResult>;
	notifyChild(nodeId: string, childRunId: string, state: RunState): Promise<void>;
}

// 匿名クラス推論ではprotected混入で宣言出力不可
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

/** `createRunClass`の戻り値, wranglerのclass_nameはそのエクスポート名 */
export type RunClass = new (ctx: DurableObjectState, env: RunEnv) => TsumugiRunInstance;

export type RunOptions = {
	flows: Flows;
	bindings: Record<string, BindingConfig>;
	settings?: RunSettings;
	/** 失敗通知先のbinding(#30), ノードのジョブにも同じ宛先が必要 */
	failureBinding?: string | null;
	/** 終端通知の宛先と対象(#96), ノードのジョブにも同じ値が必要 */
	settled?: SettledTarget | null;
	/** 投入時の既定値付与フック(#96), ノードの投入にも適用 */
	onEnqueue?: EnqueueHook;
};

/**
 * 進行判断は`core/run.ts`の純粋関数(ADR-0018, ADR-0029)
 * flow定義はDOへ保存不可(写像関数を含む), クロージャから取得(ADR-0030)
 */
export function createRunClass({ flows, bindings, settings = {}, failureBinding, settled, onEnqueue }: RunOptions): RunClass {
	const maxNodes = settings.maxNodes ?? DEFAULT_MAX_NODES;
	const maxDepth = settings.maxDepth ?? DEFAULT_MAX_DEPTH;
	const nameOf = (child: AnyFlow) => Object.keys(flows).find((name) => flows[name] === child);
	const retention: Retention = {
		doneMs: settings.sweepAfterMs ?? DEFAULT_SWEEP_AFTER_MS,
		failedMs: settings.failedRetentionMs ?? DEFAULT_RUN_FAILED_RETENTION_MS,
	};
	const client = createClient<RunEnv>(
		bindings,
		{
			...(failureBinding === undefined ? {} : { failureBinding }),
			...(settled === undefined ? {} : { settled }),
		},
		onEnqueue ? { onEnqueue } : {},
	);

	return class TsumugiRun extends DurableObject<RunEnv> {
		/** テストからの差し替え用にpublic */
		clock: Clock = systemClock;

		#repo: RunRepo | undefined;
		#ticking = false;

		get repo(): RunRepo {
			if (!this.#repo) this.#repo = new RunRepo(this.ctx.storage);
			return this.#repo;
		}

		// DO名がrunId, worker側は`idFromName(runId)`で参照(ADR-0029)
		get runId(): string {
			return this.ctx.id.name ?? '';
		}

		// 同一runIdは同一DOで二度目の開始を不可分に拒否(ADR-0029)
		async start(input: StartInput): Promise<StartResult> {
			const now = this.clock.now();
			const runId = this.runId;
			const existing = this.repo.findRun();
			if (existing) return { id: runId, created: false };

			const flow = Object.hasOwn(flows, input.flow) ? flows[input.flow] : undefined;
			if (!flow) throw new Error(`flow is not registered: ${input.flow}`);

			const depth = input.depth ?? 0;
			// 深さ判定は子側で実施, 親の上限設定に非依存
			if (depth > maxDepth) throw new Error(`subflow nesting exceeded the limit: ${maxDepth}`);

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

		// DO間呼び出しの入れ子回避で記録のみ(ADR-0031)
		async notify(events: readonly NodeEvent[]): Promise<void> {
			const now = this.clock.now();
			const runId = this.runId;
			// 削除後の通知は破棄, 再作成では保持期間が無意味
			if (!this.repo.findRun()) return;

			const touched: string[] = [];
			for (const event of events) {
				const row = this.repo.findNode(event.nodeId);
				// ジョブ差し替え済みなら古い通知, 再実行結果の上書き防止(ADR-0034)
				if (!row || row.job_id !== event.jobId) continue;
				// 取り消し通知は要求の追認, 期限超過で先にFAILEDのノードは上書きなし(ADR-0039)
				if (event.state === 'CANCELLED' && isNodeTerminal(row.state as NodeState)) continue;

				// 子を先に作成, 親の決着後では下流が子の完了前に実行(ADR-0032)
				const spawned = this.#applySpawns(event.nodeId, event.spawns ?? [], now);
				touched.push(...spawned.ids);

				// 子の作成失敗時は親をFAILED, 成功扱いでは下流が子の完了前に実行
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
				this.repo.appendRunOutbox();
				this.repo.appendNodeOutbox(runId, touched);
				await this.#armAlarm(now);
			}
		}

		// 状態のみノードへ反映し戻り値は対象外(ADR-0035)
		async notifyChild(nodeId: string, childRunId: string, state: RunState): Promise<void> {
			const now = this.clock.now();
			const run = this.repo.findRun();
			if (!run) return;

			const row = this.repo.findNode(nodeId);
			// 子run差し替え済みなら古い通知, 再実行結果の上書き防止(ADR-0034)
			if (!row || row.child_run_id !== childRunId || state === 'RUNNING') return;
			// 起動失敗判定済みノード, 応答喪失で子のみ進行した通知は適用なし
			if (isNodeTerminal(row.state as NodeState)) return;

			this.repo.updateNode(nodeId, { state, ...(state === 'FAILED' ? { error: `child run failed: ${childRunId}` } : {}) }, now);
			this.repo.appendRunOutbox();
			this.repo.appendNodeOutbox(run.id, [nodeId]);
			await this.#armAlarm(now);
		}

		// 照会で再生成される空のDOは行もalarmも無く無害(ADR-0040)
		async state(): Promise<RunState | null> {
			return (this.repo.findRun()?.state as RunState | undefined) ?? null;
		}

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

		async retry(): Promise<MutationResult> {
			const now = this.clock.now();
			const row = this.repo.findRun();
			if (!row) return { ok: false, reason: 'gone' };
			if (row.state !== 'FAILED') return { ok: false, reason: 'invalid-state' };

			const aborted = row.expired === 1 && row.cancelling === 0 ? deadlineErrorOf(row.deadline_ms) : null;
			const reset = this.repo.resetForRetry(now, aborted);
			// 再開直後の再超過防止(ADR-0039)
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
				// alarm()のthrowはworkerdリトライ6回で終了
				console.error('tsumugi: run tick failed', error);
				// tick中に他処理が設定した早い予定は維持
				await this.#armAlarm(this.clock.now() + 5_000);
			}
		}

		async #tick(): Promise<void> {
			// 同時実行では同一ノードに別ジョブIDを予約し得る, 予定のみ再設定し終了
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
				// flow定義の消失は待機で解決不可, 理由を記録しFAILEDへ(ADR-0030)
				// 決着済みは再設定なし, 状態と投影の再追記回避
				if (runRow.state === 'RUNNING') this.#failRun(runRow.id, `flow is not registered: ${runRow.flow}`, now);
				const projected = await this.#project();
				// 親への通知と削除は通常の決着と同手順, 省略時は親ノードとDOが残存
				const notified = await this.#notifyParent(this.repo.findRun()?.state as RunState, now);
				if (notified && (await this.#sweep(now))) return;
				if (projected >= PROJECTION_LIMIT || this.repo.hasOutbox()) await this.#armAlarm(now);
				else if (!notified) await this.#armAlarm(now + NOTIFY_RETRY_MS);
				else await this.#armSweep(now);
				return;
			}

			const definitions = new Map(flow.nodes.map((node) => [node.id, node]));
			const runInput = JSON.parse(runRow.input) as unknown;
			const cancelling = runRow.cancelling === 1;
			// 期限超過は取り消しと同手順で中断(ADR-0039)
			// 超過フラグはRUNNING中に一度だけ永続化, 毎tick時計判定では決着済みrunがFAILEDへ反転
			let expired = runRow.expired === 1;
			if (!expired && runRow.state === 'RUNNING' && runRow.deadline_at !== null && runRow.deadline_at <= now) {
				this.repo.markExpired(runRow.id, now);
				expired = true;
			}
			// 中断ノードの理由, runに理由の列なし, 取り消しはCANCELLEDのまま
			const deadlineError = expired && !cancelling ? deadlineErrorOf(runRow.deadline_ms) : null;

			const touched = new Set<string>();
			const inputs: EnqueueInput[] = [];
			const starting: string[] = [];
			const subflows: SubflowStart[] = [];
			// 本tickで処理済みのノード, 投入は一括で判断後もPENDINGのまま
			const handled = new Set<string>();
			// 取り消し要求済みで終端通知待ちのノード, 残存決定も再実行対象外(ADR-0052)
			const waiting = new Set<string>();
			let deferred = 0;

			// 中断の連鎖はadvance1回で1段のみ, 新規決定が無くなるまで反復
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
						waiting,
						deadlineError,
					});
					for (const id of applied) touched.add(id);
				}
			}

			if (inputs.length > 0) {
				await client.enqueueMany(this.env, inputs);
			}
			// 子runは同一IDの再開始で既存返却, 再実行でも重複なし(ADR-0029)
			const unstarted = new Set<string>();
			for (const child of subflows) {
				try {
					const stub = this.#runStub(child.childRunId);
					const started = await stub.start({
						flow: child.flow,
						input: child.input,
						parent: { runId: runRow.id, nodeId: child.nodeId },
						depth: runRow.depth + 1,
					});
					if (!started.created && (await this.#resumeChild(stub, child.nodeId, now))) touched.add(child.nodeId);
				} catch (error) {
					// 上限超過等は待機で解決不可, FAILEDにしないと毎tick同じ失敗
					this.repo.updateNode(child.nodeId, { state: 'FAILED', error: `failed to start child run: ${messageOf(error)}` }, now);
					unstarted.add(child.nodeId);
					touched.add(child.nodeId);
				}
			}
			for (const id of starting) {
				if (unstarted.has(id)) continue;
				const current = this.repo.findNode(id);
				// 投入待ち中に完了通知があり得る, 終端ノードを戻すと以後の通知なし
				if (!current || isNodeTerminal(current.state as NodeState)) continue;
				this.repo.updateNode(id, { state: subflows.some((child) => child.nodeId === id) ? 'RUNNING' : 'SCHEDULED' }, now);
				touched.add(id);
			}

			// 決定反映後の内容で状態決定, 反映前では1tick前の状態を投影
			const settled = advance({ nodes: this.repo.views(), cancelling, expired });
			if (settled.state !== runRow.state) {
				this.repo.setRunState(runRow.id, settled.state, now);
				this.repo.appendRunOutbox();
			} else if (touched.size > 0) {
				// 進捗集計の変化でrunも投影対象
				this.repo.appendRunOutbox();
			}
			this.repo.appendNodeOutbox(runRow.id, [...touched]);

			const projected = await this.#project();
			const notified = await this.#notifyParent(settled.state, now);
			if (notified && (await this.#sweep(now))) return;

			// 通知待ちノードの決定は除外, 次の起動はnotify(ADR-0052)
			// outbox残も確認, tickのawait中の通知は未投影で残存
			const hasMore =
				deferred > 0 ||
				projected >= PROJECTION_LIMIT ||
				settled.decisions.some((decision) => !waiting.has(decision.id)) ||
				this.repo.hasOutbox();
			if (hasMore) await this.#armAlarm(now);
			else if (!notified) await this.#armAlarm(now + NOTIFY_RETRY_MS);
			else if (settled.state === 'RUNNING') await this.#armDeadline(now);
			else await this.#armSweep(now);
		}

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
				waiting: Set<string>;
				deadlineError: string | null;
			},
		): Promise<string[]> {
			const { definitions, runInput, runId, now, inputs, starting, subflows, waiting, deadlineError } = context;
			const row = this.repo.findNode(decision.id);
			if (!row) return [];

			// 起動直前に判定, 依存の戻り値が揃う時点(ADR-0041)
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
					// ジョブIDを先に確保, 投入後の中断でも同一IDの再投入で重複なし
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
					// 子runIdは親runIdとノードIDから決定, 再送でも同じ子(ADR-0029)
					let childRunId: string;
					try {
						childRunId = formatRunId({ flow: row.subflow, localId: `${parseRunId(runId).localId}-${row.id}` });
					} catch (error) {
						// flow名がID形式として不正, 待機で解決不可
						this.repo.updateNode(row.id, { state: 'FAILED', error: `invalid child run id: ${messageOf(error)}` }, now);
						return [row.id];
					}
					// 子の入力は状態更新前に構築, 失敗時の起動中ノード残存防止
					const input = this.#evaluate(row, 'input', now, () => definition.input(runInput, this.#depsOf(definition)));
					if (!input.ok) return [row.id];

					if (row.child_run_id === null) this.repo.updateNode(row.id, { childRunId }, now);
					starting.push(row.id);
					subflows.push({ nodeId: row.id, childRunId, flow: row.subflow, input: input.value });
					return [row.id];
				}

				case 'expand':
					return this.#expand(row, definitions, runInput, now);

				case 'aggregate': {
					// fan-outノードはジョブなし, 戻り値は子の成否集計(ADR-0035)
					this.repo.updateNode(row.id, { state: 'COMPLETED', result: JSON.stringify(this.repo.childSummary(row.id)) }, now);
					return [row.id];
				}

				case 'skip':
					// 不実行理由は状態から判別不能, 画面表示用に保存(ADR-0041)
					this.repo.updateNode(row.id, { state: 'SKIPPED', error: decision.reason }, now);
					return [row.id];

				case 'cancel': {
					const terminal =
						deadlineError !== null ? ({ state: 'FAILED', error: deadlineError } as const) : ({ state: 'CANCELLED' } as const);
					if (row.child_run_id !== null) {
						// 子のcancelは要求受理のみ, 終端は子からの通知で確定
						await this.#runStub(row.child_run_id).cancel();
						waiting.add(row.id);
						return [];
					}
					if (row.job_id === null || row.state === 'PENDING') {
						this.repo.updateNode(row.id, terminal, now);
						return [row.id];
					}
					// QUEUED以降は協調的取り消しの要求のみ, 終端はジョブの通知で確定(ADR-0052)
					const result = await this.#jobStub(row.job_id).cancel(row.job_id);
					if (!result.ok || result.requested) {
						waiting.add(row.id);
						return [];
					}
					this.repo.updateNode(row.id, terminal, now);
					return [row.id];
				}
			}
		}

		// 件数のみ実行時確定(ADR-0032)
		#expand(row: NodeRow, definitions: Map<string, FlowNode>, runInput: unknown, now: number): string[] {
			const definition = definitions.get(row.id);
			if (!definition?.over || !definition.item) {
				this.repo.updateNode(row.id, { state: 'FAILED', error: `fan-out definition is missing: ${row.id}` }, now);
				return [row.id];
			}

			const items = this.#evaluate(row, 'over', now, () => definition.over!(runInput, this.#depsOf(definition)));
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

		// 作成不可は例外でなく理由を返却, 例外では通知滞留
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

		#buildJob(row: NodeRow, definitions: Map<string, FlowNode>, runInput: unknown): BuiltJob | null {
			if (row.payload !== null) {
				return { payload: JSON.parse(row.payload), ...(JSON.parse(row.options ?? '{}') as NodeJobOptions) };
			}

			const definition = definitions.get(row.id);
			if (!definition) return null;
			const deps = this.#depsOf(definition);
			const concurrencyKey =
				typeof definition.concurrencyKey === 'function' ? definition.concurrencyKey(runInput, deps) : definition.concurrencyKey;
			return {
				payload: definition.input(runInput, deps),
				...definition.job,
				...(concurrencyKey === undefined ? {} : { concurrencyKey }),
			};
		}

		// 例外をノードのFAILEDへ変換, 未変換では毎tick同じ位置で停止
		#evaluate<T>(row: NodeRow, label: string, now: number, run: () => T): { ok: true; value: T } | { ok: false } {
			try {
				return { ok: true, value: run() };
			} catch (error) {
				this.repo.updateNode(row.id, { state: 'FAILED', error: `${label} failed: ${messageOf(error)}` }, now);
				return { ok: false };
			}
		}

		#gate(row: NodeRow, definitions: Map<string, FlowNode>, runInput: unknown, now: number): string[] | null {
			const definition = definitions.get(row.id);
			if (!definition?.when) return null;

			const passed = this.#evaluate(row, 'when', now, () => definition.when!(runInput, this.#depsOf(definition)));
			if (!passed.ok) return [row.id];
			if (passed.value) return null;

			this.repo.updateNode(row.id, { state: 'SKIPPED', error: 'when returned false' }, now);
			return [row.id];
		}

		#depsOf(definition: FlowNode): Record<string, unknown> {
			const entries = Object.entries(definition.after);
			const results = this.repo.resultsOf(entries.map(([, id]) => id));
			return Object.fromEntries(entries.map(([name, id]) => [name, results.get(id)]));
		}

		#shardOf(binding: string, runId: string): number {
			// runIdをpartitionKeyに使用, 同一shardでRun DO側のID決定が可能(ADR-0011)
			return resolveShard(binding, configOf(bindings, binding)?.shards ?? 1, runId);
		}

		// 終端済み子runは通知済みで再通知なし(ADR-0034)
		async #resumeChild(stub: DurableObjectStub<RunPeerStub>, nodeId: string, now: number): Promise<boolean> {
			const state = await stub.state();
			if (state === 'FAILED') {
				await stub.retry();
				return false;
			}
			if (state !== 'COMPLETED' && state !== 'CANCELLED') return false;
			this.repo.updateNode(nodeId, { state }, now);
			return true;
		}

		// 親なし, 非終端のrunはtrue(削除の阻害理由なし)
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
			// ノードも投影, 除外では読み取りモデルにPENDINGが残存
			this.repo.appendNodeOutbox(runId, failed);
		}

		async #project(): Promise<number> {
			const rows = this.repo.outboxBatch(PROJECTION_LIMIT);
			if (rows.length === 0) return 0;
			await projectRun(this.env.TSUMUGI_DB, rows);
			this.repo.deleteOutboxThrough(rows[rows.length - 1]!.seq);
			return rows.length;
		}

		async #sweep(now: number): Promise<boolean> {
			const row = this.repo.findRun();
			if (!row || row.state === 'RUNNING') return false;
			if (this.repo.hasOutbox()) return false;
			const keepFor = row.state === 'FAILED' ? retention.failedMs : retention.doneMs;
			if (row.updated_at + keepFor > now) return false;
			// SQLiteごと削除, 1 run 1インスタンスで残す行なし(ADR-0029)
			// 完了待機, 未待機では削除失敗が検知不能
			await this.ctx.storage.deleteAll();
			return true;
		}

		/**
		 * 停滞runの超過判定用(ADR-0039)
		 * 超過後は設定なし, 実行中ノードの終端は通知経由
		 */
		async #armDeadline(now: number): Promise<void> {
			const row = this.repo.findRun();
			if (!row || row.deadline_at === null || row.deadline_at <= now) return;
			await this.#armAlarm(row.deadline_at);
		}

		async #armSweep(now: number): Promise<void> {
			const row = this.repo.findRun();
			if (!row || row.state === 'RUNNING') return;
			const keepFor = row.state === 'FAILED' ? retention.failedMs : retention.doneMs;
			// tick中設定のalarm後退防止, 後退では通知処理が保持期間まで遅延
			await this.#armAlarm(Math.max(row.updated_at + keepFor, now + 1_000));
		}

		async #armAlarm(at: number): Promise<void> {
			const current = await this.ctx.storage.getAlarm();
			if (current === null || current > at) await this.ctx.storage.setAlarm(at);
		}
	};
}

export type { AnyFlow, FlowShape, NodeState };
