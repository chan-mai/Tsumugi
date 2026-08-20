import type { PayloadOf, Performers, PerformersOf, ReqOf, Requirements, ResultOf } from './api.js';
import type { Backoff, DeliveryGuarantee } from './types.js';

/**
 * flowの定義(ADR-0030)
 *
 * 写像関数はJSON化不能でDOへ保存不可、定義はコードにしか無い
 * Run DOへ渡るのは`shapeOf`が返す形だけで、関数はその都度ここから取得
 * uniqueKeyはノードでは不可(ADR-0033)
 */

/** ノードIDの許可文字, `parent:child`の子IDに入る区切り文字は拒否(ADR-0032) */
const NODE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export class InvalidFlowError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidFlowError';
	}
}

/** flow定義の中でノードを指す印, 型のために結果の型を保持 */
export type NodeRef<Result = unknown> = {
	readonly id: string;
	/** 型のためだけのプロパティ, 実体なし */
	readonly __result?: Result;
};

/** fan-outノードが後続へ渡す集計値, 個々のresultは対象外(ADR-0035) */
export type FanOutSummary = { total: number; succeeded: number; failed: number };

type Refs = Record<string, NodeRef<any>>;

/** `after`のキーがそのまま受け取り口の名前 */
type DepsOf<A extends Refs> = { [K in keyof A]: A[K] extends NodeRef<infer R> ? R : never };

/**
 * 依存が成功していない場合も進む指定では、戻り値が無い依存も対象(ADR-0041)
 * 失敗したノードには戻り値が無く、受け取り口は未定義込みの型
 */
type PartialDepsOf<A extends Refs> = { [K in keyof A]: DepsOf<A>[K] | undefined };

/**
 * 依存の成否に対する発火条件(ADR-0041)
 * successは全ての依存の成功, failureは1つ以上の失敗, alwaysは成否を問わない決着
 */
export type NodeTrigger = 'success' | 'failure' | 'always';

export const NODE_TRIGGERS: readonly NodeTrigger[] = ['success', 'failure', 'always'];

/** uniqueKeyを必須と宣言したperformerはノードに使用不可(ADR-0033) */
type NodeBindings<M extends Performers> = { [K in keyof M]: ReqOf<M[K]>['uniqueKey'] extends true ? never : K }[keyof M];

/** ノードに書けるジョブの設定, uniqueKeyのみ非対応 */
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

/** flow全体の設定, ノード単位の設定はノードのオプションが持つ */
export type FlowOptions = {
	/** run全体の期限(ms), 超過したrunは中断されFAILEDへ(ADR-0039) */
	deadlineMs?: number;
};

/** 期限の検査, flow定義とstartの両方で使用(ADR-0039) */
export function assertDeadlineMs(value: number): void {
	if (!Number.isInteger(value) || value <= 0) {
		throw new InvalidFlowError(`deadlineMs must be a positive integer: ${value}`);
	}
}

/**
 * 発火条件ごとに受け取り口の型を分ける(ADR-0041)
 * successの指定でだけ依存の戻り値が揃い、写像関数の引数は判別可能ユニオンで切り替え
 * `when`はfalseを返すとSKIPPEDになり, 下流も依存が成功していないので進まない
 */
type NodeShape<M extends Performers, K extends keyof M, Input, Deps> = NodeJobOptions & {
	input: (input: Input, deps: Deps) => PayloadOf<M[K]>;
	when?: (input: Input, deps: Deps) => boolean;
} & ConcurrencyKeyOption<ReqOf<M[K]>, (input: Input, deps: Deps) => string>;

export type NodeOptions<M extends Performers, K extends keyof M, Input, A extends Refs> =
	| (NodeShape<M, K, Input, DepsOf<A>> & { after?: A; trigger?: 'success' })
	| (NodeShape<M, K, Input, PartialDepsOf<A>> & { after?: A; trigger: 'failure' | 'always' });

type FanOutShape<M extends Performers, K extends keyof M, Input, Item, Deps> = NodeJobOptions & {
	/** 展開する対象, 件数だけが実行時に確定 */
	over: (input: Input, deps: Deps) => readonly Item[];
	input: (item: Item, input: Input, index: number) => PayloadOf<M[K]>;
	/** 子ノードIDの決め方,既定は項番(ADR-0032) */
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

/** 子のrunへ渡す入力の構築, 戻り値の型は子のflowの入力に一致 */
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
	 * 別のflowをrunとして起動し、終端に達するまで待機
	 * 子の戻り値は非対象, runを跨ぐデータの増加防止(ADR-0035)
	 */
	subflow<ChildInput, const A extends Refs = {}>(
		id: string,
		flow: Flow<ChildInput>,
		options: SubflowOptions<Input, A, ChildInput>,
	): NodeRef<void>;
};

/** 構築済みノードが持つ関数, 型引数を除いた実行時の形 */
export type InputFn = (input: unknown, deps: Record<string, unknown>) => unknown;
export type OverFn = (input: unknown, deps: Record<string, unknown>) => readonly unknown[];
export type ItemFn = (item: unknown, input: unknown, index: number) => unknown;
export type ChildKeyFn = (item: unknown, index: number) => string;
export type ConcurrencyKeyFn = (input: unknown, deps: Record<string, unknown>) => string;
export type WhenFn = (input: unknown, deps: Record<string, unknown>) => boolean;

/** 構築済みのノード, 関数はここにしか無い */
export type FlowNode = {
	id: string;
	binding: string;
	/** fan-outノード, ジョブを持たず子の展開と集約のみ */
	container: boolean;
	/** 受け取り口の名前から依存先のノードIDへ */
	after: Readonly<Record<string, string>>;
	/** 依存の成否に対する発火条件(ADR-0041) */
	trigger: NodeTrigger;
	job: NodeJobOptions;
	input: InputFn;
	/** 実行するかの判定, 省略時は常に実行(ADR-0041) */
	when?: WhenFn;
	concurrencyKey?: string | ConcurrencyKeyFn;
	/** fan-outノードのみ */
	over?: OverFn;
	/** fan-outノードのみ, 子1件ぶんのpayload */
	item?: ItemFn;
	/** fan-outノードのみ */
	key?: ChildKeyFn;
	/** fan-outノードのみ, 子に渡す設定 */
	childConcurrencyKey?: string | ChildKeyFn;
	/** subflowノードのみ, 起動する子のflow定義 */
	subflow?: AnyFlow;
};

export type Flow<Input = unknown> = {
	readonly nodes: readonly FlowNode[];
	/** run全体の期限(ms), startの指定が優先(ADR-0039) */
	readonly deadlineMs?: number;
	/** 型のためだけのプロパティ, 実体なし */
	readonly __input?: Input;
};

/** 任意のflowを受ける型, `flows`の要素として使用 */
export type AnyFlow = Flow<any>;

export type Flows = Record<string, AnyFlow>;

/** flowの入力の型, `start`の引数を`flows`から導出 */
export type InputOf<F> = F extends Flow<infer I> ? I : never;

/** Run DOへ保存するグラフの形(ADR-0030), 関数は対象外 */
export type FlowShapeNode = {
	id: string;
	binding: string;
	container: boolean;
	after: readonly string[];
	/** 依存の成否に対する発火条件, 進行判断が毎tick読む(ADR-0041) */
	trigger: NodeTrigger;
	subflow?: string;
};
export type FlowShape = readonly FlowShapeNode[];

/**
 * 保存する形へ変換
 * subflowノードは起動する子のflow名が必要, 名前はflow定義に無く引数で受領
 */
export function shapeOf(flow: AnyFlow, nameOf?: (child: AnyFlow) => string | undefined): FlowShape {
	return flow.nodes.map((node) => ({
		id: node.id,
		binding: node.binding,
		container: node.container,
		// 同じ依存先を複数の受け取り口で受けた場合の重複を除去, 依存数の集計のずれを防止
		after: [...new Set(Object.values(node.after))],
		trigger: node.trigger,
		...(node.subflow ? { subflow: subflowNameOf(node.id, nameOf?.(node.subflow)) } : {}),
	}));
}

/** 起動先のflow名, 名前の無い形の保存は誤りの発覚がrunId構築時まで遅延 */
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

/** 発火条件と判定の抽出, 3種のノードで同じ形(ADR-0041) */
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
 * `performers`からflowを定義する関数を作る
 *
 * `performers`は型の伝達のみの引数で実行時には未使用
 * この経由でbinding名もpayloadも必須キーも`performers`1箇所から確定(ADR-0010)
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
			// 依存が無いと成否の判定対象が無い, 意図が不明確な記述は拒否
			if (node.trigger !== 'success' && Object.keys(node.after).length === 0) {
				throw new InvalidFlowError(`trigger requires at least one dependency: ${node.id}`);
			}
			if (seen.has(node.id)) throw new InvalidFlowError(`duplicate node id: ${node.id}`);
			seen.add(node.id);
			// 宣言済みのノードしか変数で参照できず、循環は構文上あり得ない
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
					// bindingはperformerを指さない, 画面には起動するflow名を表示
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
					// fan-outノード自体はジョブを実行せずpayload構築も不要
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
