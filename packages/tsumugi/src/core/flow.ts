import type { PayloadOf, Performers, PerformersOf, ReqOf, Requirements, ResultOf } from './api.js';
import type { Backoff, DeliveryGuarantee } from './types.js';

// flow定義, 写像関数はJSON化不能でコードにのみ存在(ADR-0030)
// Run DOへは`shapeOf`の形のみ送信, 関数は都度ここから取得

// `parent:child`形式の子ID用に区切り文字拒否(ADR-0032)
const NODE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export class InvalidFlowError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidFlowError';
	}
}

export type NodeRef<Result = unknown> = {
	readonly id: string;
	/** 型専用, 実体なし */
	readonly __result?: Result;
};

/** fan-outノードが後続へ渡す集計値, 個々のresultは対象外(ADR-0035) */
export type FanOutSummary = { total: number; succeeded: number; failed: number };

type Refs = Record<string, NodeRef<any>>;

type DepsOf<A extends Refs> = { [K in keyof A]: A[K] extends NodeRef<infer R> ? R : never };

// failure, always指定時のdeps, 失敗ノードは戻り値なしでundefined込み(ADR-0041)
type PartialDepsOf<A extends Refs> = { [K in keyof A]: DepsOf<A>[K] | undefined };

/**
 * 依存の成否に対する発火条件(ADR-0041)
 * successは全依存の成功, failureは1つ以上の失敗, alwaysは成否不問の終端到達
 */
export type NodeTrigger = 'success' | 'failure' | 'always';

export const NODE_TRIGGERS: readonly NodeTrigger[] = ['success', 'failure', 'always'];

type NodeBindings<M extends Performers> = { [K in keyof M]: ReqOf<M[K]>['uniqueKey'] extends true ? never : K }[keyof M];

export type NodeJobOptions = {
	maxAttempts?: number;
	backoff?: Backoff;
	delayMs?: number;
	runAt?: number;
	timeoutMs?: number;
	priority?: number;
	guarantee?: DeliveryGuarantee;
};

type ConcurrencyKeyOption<R extends Requirements, Resolve> = R['concurrencyKey'] extends true
	? { concurrencyKey: string | Resolve }
	: { concurrencyKey?: string | Resolve };

export type FlowOptions = {
	/** run全体の期限(ms), 超過時は中断しFAILED(ADR-0039) */
	deadlineMs?: number;
};

export function assertDeadlineMs(value: number): void {
	if (!Number.isInteger(value) || value <= 0) {
		throw new InvalidFlowError(`deadlineMs must be a positive integer: ${value}`);
	}
}

/**
 * 依存の戻り値が揃うのはsuccessのみ, depsの型は発火条件の判別可能ユニオン(ADR-0041)
 * `when`がfalseでSKIPPED, 下流もsuccessでは実行なし
 */
type NodeShape<M extends Performers, K extends keyof M, Input, Deps> = NodeJobOptions & {
	input: (input: Input, deps: Deps) => PayloadOf<M[K]>;
	when?: (input: Input, deps: Deps) => boolean;
} & ConcurrencyKeyOption<ReqOf<M[K]>, (input: Input, deps: Deps) => string>;

export type NodeOptions<M extends Performers, K extends keyof M, Input, A extends Refs> =
	| (NodeShape<M, K, Input, DepsOf<A>> & { after?: A; trigger?: 'success' })
	| (NodeShape<M, K, Input, PartialDepsOf<A>> & { after?: A; trigger: 'failure' | 'always' });

type FanOutShape<M extends Performers, K extends keyof M, Input, Item, Deps> = NodeJobOptions & {
	over: (input: Input, deps: Deps) => readonly Item[];
	input: (item: Item, input: Input, index: number) => PayloadOf<M[K]>;
	/** 子ノードID, 既定は項番(ADR-0032) */
	key?: (item: Item, index: number) => string;
	when?: (input: Input, deps: Deps) => boolean;
} & ConcurrencyKeyOption<ReqOf<M[K]>, (item: Item, index: number) => string>;

export type FanOutOptions<M extends Performers, K extends keyof M, Input, A extends Refs, Item> =
	| (FanOutShape<M, K, Input, Item, DepsOf<A>> & { after?: A; trigger?: 'success' })
	| (FanOutShape<M, K, Input, Item, PartialDepsOf<A>> & { after?: A; trigger: 'failure' | 'always' });

type SubflowShape<Input, ChildInput, Deps> = {
	input: (input: Input, deps: Deps) => ChildInput;
	when?: (input: Input, deps: Deps) => boolean;
};

export type SubflowOptions<Input, A extends Refs, ChildInput> =
	| (SubflowShape<Input, ChildInput, DepsOf<A>> & { after?: A; trigger?: 'success' })
	| (SubflowShape<Input, ChildInput, PartialDepsOf<A>> & { after?: A; trigger: 'failure' | 'always' });

export type FlowBuilder<M extends Performers, Input> = {
	node<K extends NodeBindings<M>, const A extends Refs = {}>(
		id: string,
		binding: K,
		options: NodeOptions<M, K, Input, A>,
	): NodeRef<ResultOf<M[K]>>;
	fanOut<K extends NodeBindings<M>, Item, const A extends Refs = {}>(
		id: string,
		binding: K,
		options: FanOutOptions<M, K, Input, A, Item>,
	): NodeRef<FanOutSummary>;
	/**
	 * 別flowをrunとして起動し終端まで待機
	 * 子の戻り値は受け渡しなし, run間のデータ増加防止(ADR-0035)
	 */
	subflow<ChildInput, const A extends Refs = {}>(
		id: string,
		flow: Flow<ChildInput>,
		options: SubflowOptions<Input, A, ChildInput>,
	): NodeRef<void>;
};

export type InputFn = (input: unknown, deps: Record<string, unknown>) => unknown;
export type OverFn = (input: unknown, deps: Record<string, unknown>) => readonly unknown[];
export type ItemFn = (item: unknown, input: unknown, index: number) => unknown;
export type ChildKeyFn = (item: unknown, index: number) => string;
export type ConcurrencyKeyFn = (input: unknown, deps: Record<string, unknown>) => string;
export type WhenFn = (input: unknown, deps: Record<string, unknown>) => boolean;

/** 関数の保持はここのみ */
export type FlowNode = {
	id: string;
	binding: string;
	/** fan-outノード, ジョブを持たず子の展開と集約のみ */
	container: boolean;
	/** depsのプロパティ名から依存先ノードIDへの対応 */
	after: Readonly<Record<string, string>>;
	trigger: NodeTrigger;
	job: NodeJobOptions;
	input: InputFn;
	/** 省略時は常に実行(ADR-0041) */
	when?: WhenFn;
	concurrencyKey?: string | ConcurrencyKeyFn;
	/** fan-outノードのみ */
	over?: OverFn;
	/** fan-outノードのみ, 子1件分のpayload */
	item?: ItemFn;
	/** fan-outノードのみ */
	key?: ChildKeyFn;
	/** fan-outノードのみ, 子に渡す設定 */
	childConcurrencyKey?: string | ChildKeyFn;
	/** subflowノードのみ */
	subflow?: AnyFlow;
};

export type Flow<Input = unknown> = {
	readonly nodes: readonly FlowNode[];
	/** run全体の期限(ms), startの指定が優先(ADR-0039) */
	readonly deadlineMs?: number;
	/** 型専用, 実体なし */
	readonly __input?: Input;
};

export type AnyFlow = Flow<any>;

export type Flows = Record<string, AnyFlow>;

export type InputOf<F> = F extends Flow<infer I> ? I : never;

/** Run DOへ保存するグラフ形状(ADR-0030) */
export type FlowShapeNode = {
	id: string;
	binding: string;
	container: boolean;
	after: readonly string[];
	/** 毎tickの進行判断で参照(ADR-0041) */
	trigger: NodeTrigger;
	subflow?: string;
};
export type FlowShape = readonly FlowShapeNode[];

/** subflowの子flow名はflow定義に無く`nameOf`で取得 */
export function shapeOf(flow: AnyFlow, nameOf?: (child: AnyFlow) => string | undefined): FlowShape {
	return flow.nodes.map((node) => ({
		id: node.id,
		binding: node.binding,
		container: node.container,
		// 複数プロパティで同じ依存先を指す場合の重複除去, 依存数集計の不一致防止
		after: [...new Set(Object.values(node.after))],
		trigger: node.trigger,
		...(node.subflow ? { subflow: subflowNameOf(node.id, nameOf?.(node.subflow)) } : {}),
	}));
}

// flow名が空のまま保存すると誤りの検出がrunId構築時まで遅延
function subflowNameOf(nodeId: string, name: string | undefined): string {
	if (!name) throw new InvalidFlowError(`subflow target is not registered: ${nodeId}`);
	return name;
}

export function isNodeId(id: string): boolean {
	return NODE_ID_PATTERN.test(id);
}

export function assertNodeId(id: string): void {
	if (!isNodeId(id)) {
		throw new InvalidFlowError(`invalid node id: ${JSON.stringify(id)} (alphanumeric, hyphen and underscore only)`);
	}
}

const refIds = (after: Refs | undefined): Record<string, string> =>
	Object.fromEntries(Object.entries(after ?? {}).map(([name, ref]) => [name, ref.id]));

const gateOf = (options: Record<string, any>): { trigger: NodeTrigger; when?: WhenFn } => ({
	trigger: (options.trigger as NodeTrigger | undefined) ?? 'success',
	...(options.when !== undefined ? { when: options.when as WhenFn } : {}),
});

const jobOptionsOf = (options: NodeJobOptions): NodeJobOptions => ({
	...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
	...(options.backoff !== undefined ? { backoff: options.backoff } : {}),
	...(options.delayMs !== undefined ? { delayMs: options.delayMs } : {}),
	...(options.runAt !== undefined ? { runAt: options.runAt } : {}),
	...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
	...(options.priority !== undefined ? { priority: options.priority } : {}),
	...(options.guarantee !== undefined ? { guarantee: options.guarantee } : {}),
});

/**
 * `performers`は型の伝達専用, 実行時は未使用
 * binding名, payload, 必須キーを`performers`の1箇所から確定(ADR-0010)
 */
export function createFlow<const R extends Record<string, unknown>>(_performers: R) {
	return function flow<Input>(build: (f: FlowBuilder<PerformersOf<R>, Input>) => void, options?: FlowOptions): Flow<Input> {
		if (options?.deadlineMs !== undefined) assertDeadlineMs(options.deadlineMs);
		const nodes: FlowNode[] = [];
		const seen = new Set<string>();

		const register = (node: FlowNode): NodeRef<any> => {
			assertNodeId(node.id);
			if (!NODE_TRIGGERS.includes(node.trigger)) {
				throw new InvalidFlowError(`invalid trigger: ${node.id} -> ${JSON.stringify(node.trigger)}`);
			}
			// afterが空では成否の判定対象なし, 意図不明確な記述はエラー
			if (node.trigger !== 'success' && Object.keys(node.after).length === 0) {
				throw new InvalidFlowError(`trigger requires at least one dependency: ${node.id}`);
			}
			if (seen.has(node.id)) throw new InvalidFlowError(`duplicate node id: ${node.id}`);
			seen.add(node.id);
			// 参照は宣言済みノードのみ, 循環は構文上発生不可
			for (const dependency of Object.values(node.after)) {
				if (!seen.has(dependency)) throw new InvalidFlowError(`depends on an undeclared node: ${node.id} -> ${dependency}`);
			}
			nodes.push(node);
			return { id: node.id };
		};

		const builder = {
			node(id: string, binding: string, options: Record<string, any>) {
				return register({
					id,
					binding,
					container: false,
					after: refIds(options.after as Refs | undefined),
					...gateOf(options),
					job: jobOptionsOf(options as NodeJobOptions),
					input: options.input as InputFn,
					...(options.concurrencyKey !== undefined ? { concurrencyKey: options.concurrencyKey as string | ConcurrencyKeyFn } : {}),
				});
			},
			subflow(id: string, child: AnyFlow, options: Record<string, any>) {
				return register({
					id,
					// 対応performerなし, 画面には起動するflow名を表示
					binding: '',
					container: false,
					after: refIds(options.after as Refs | undefined),
					...gateOf(options),
					job: {},
					input: options.input as InputFn,
					subflow: child,
				});
			},
			fanOut(id: string, binding: string, options: Record<string, any>) {
				return register({
					id,
					binding,
					container: true,
					after: refIds(options.after as Refs | undefined),
					...gateOf(options),
					job: jobOptionsOf(options as NodeJobOptions),
					// fan-outノード自体はジョブ非実行, payload不要
					input: () => undefined,
					over: options.over as OverFn,
					item: options.input as ItemFn,
					...(options.key !== undefined ? { key: options.key as ChildKeyFn } : {}),
					...(options.concurrencyKey !== undefined ? { childConcurrencyKey: options.concurrencyKey as string | ChildKeyFn } : {}),
				});
			},
		} as unknown as FlowBuilder<PerformersOf<R>, Input>;

		build(builder);
		if (nodes.length === 0) throw new InvalidFlowError('no nodes are declared');
		return { nodes, ...(options?.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}) };
	};
}
