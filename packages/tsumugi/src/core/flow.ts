import type { PayloadOf, Performers, PerformersOf, ReqOf, Requirements, ResultOf } from './api.js';
import type { Backoff, DeliveryGuarantee } from './types.js';

/**
 * flowの定義(ADR-0030)
 *
 * 写像関数はJSON化できないのでDOには保存できず,定義はコードにしか無い
 * Run DOへ渡るのは`shapeOf`が返す形だけで,関数はその都度ここから引く
 * uniqueKeyはノードでは受け付けない(ADR-0033)
 */

/** ノードIDに許す文字, `parent:child`で子を作るので区切り文字を弾く(ADR-0032) */
const NODE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export class InvalidFlowError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidFlowError';
	}
}

/** flow定義の中でノードを指す印,型のために結果の型を運ぶ */
export type NodeRef<Result = unknown> = {
	readonly id: string;
	/** 型のためだけのプロパティ, 実体なし */
	readonly __result?: Result;
};

/** fan-outノードが後続へ渡す集計値,個々のresultは渡さない(ADR-0035) */
export type FanOutSummary = { total: number; succeeded: number; failed: number };

type Refs = Record<string, NodeRef<any>>;

/** `after`のキーをそのまま受け取り口の名前にする */
type DepsOf<A extends Refs> = { [K in keyof A]: A[K] extends NodeRef<infer R> ? R : never };

/** uniqueKeyを必須と宣言したperformerはノードに使えない(ADR-0033) */
type NodeBindings<M extends Performers> = { [K in keyof M]: ReqOf<M[K]>['uniqueKey'] extends true ? never : K }[keyof M];

/** ノードに書けるジョブの設定, uniqueKeyだけ持たない */
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

export type NodeOptions<M extends Performers, K extends keyof M, Input, A extends Refs> = NodeJobOptions & {
	after?: A;
	input: (input: Input, deps: DepsOf<A>) => PayloadOf<M[K]>;
} & ConcurrencyKeyOption<ReqOf<M[K]>, (input: Input, deps: DepsOf<A>) => string>;

export type FanOutOptions<M extends Performers, K extends keyof M, Input, A extends Refs, Item> = NodeJobOptions & {
	after?: A;
	/** 展開する対象,件数だけが実行時に決まる */
	over: (input: Input, deps: DepsOf<A>) => readonly Item[];
	input: (item: Item, input: Input, index: number) => PayloadOf<M[K]>;
	/** 子ノードIDの決め方,既定は項番(ADR-0032) */
	key?: (item: Item, index: number) => string;
} & ConcurrencyKeyOption<ReqOf<M[K]>, (item: Item, index: number) => string>;

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
};

/** 組み立て済みのノードが持つ関数,型引数を落として実行時の形に揃える */
export type InputFn = (input: unknown, deps: Record<string, unknown>) => unknown;
export type OverFn = (input: unknown, deps: Record<string, unknown>) => readonly unknown[];
export type ItemFn = (item: unknown, input: unknown, index: number) => unknown;
export type ChildKeyFn = (item: unknown, index: number) => string;
export type ConcurrencyKeyFn = (input: unknown, deps: Record<string, unknown>) => string;

/** 組み立て済みのノード,関数はここにしか無い */
export type FlowNode = {
	id: string;
	binding: string;
	/** fan-outノード, ジョブを持たず子の展開と集約のみを行う */
	container: boolean;
	/** 受け取り口の名前から依存先のノードIDへ */
	after: Readonly<Record<string, string>>;
	job: NodeJobOptions;
	input: InputFn;
	concurrencyKey?: string | ConcurrencyKeyFn;
	/** fan-outノードのみ */
	over?: OverFn;
	/** fan-outノードのみ, 子1件ぶんのpayload */
	item?: ItemFn;
	/** fan-outノードのみ */
	key?: ChildKeyFn;
	/** fan-outノードのみ, 子に渡す設定 */
	childConcurrencyKey?: string | ChildKeyFn;
};

export type Flow<Input = unknown> = {
	readonly nodes: readonly FlowNode[];
	/** 型のためだけのプロパティ, 実体なし */
	readonly __input?: Input;
};

/** 任意のflowを受ける型, `flows`の要素として使う */
export type AnyFlow = Flow<any>;

export type Flows = Record<string, AnyFlow>;

/** flowの入力の型, `start`の引数を`flows`から決める */
export type InputOf<F> = F extends Flow<infer I> ? I : never;

/** Run DOへ保存するグラフの形(ADR-0030),関数は含まない */
export type FlowShapeNode = { id: string; binding: string; container: boolean; after: readonly string[] };
export type FlowShape = readonly FlowShapeNode[];

export function shapeOf(flow: AnyFlow): FlowShape {
	return flow.nodes.map((node) => ({
		id: node.id,
		binding: node.binding,
		container: node.container,
		// 同じ依存先を複数の受け取り口で受けた場合に重複するので畳む, 依存の数を数える側がずれる
		after: [...new Set(Object.values(node.after))],
	}));
}

export function assertNodeId(id: string): void {
	if (!NODE_ID_PATTERN.test(id)) {
		throw new InvalidFlowError(`invalid node id: ${JSON.stringify(id)} (alphanumeric, hyphen and underscore only)`);
	}
}

const refIds = (after: Refs | undefined): Record<string, string> =>
	Object.fromEntries(Object.entries(after ?? {}).map(([name, ref]) => [name, ref.id]));

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
 * `performers`は型を運ぶためだけの引数で実行時には読まない
 * これを通すことでbinding名もpayloadも必須キーも`performers`1箇所から決まる(ADR-0010)
 */
export function createFlow<const R extends Record<string, unknown>>(_performers: R) {
	return function flow<Input>(build: (f: FlowBuilder<PerformersOf<R>, Input>) => void): Flow<Input> {
		const nodes: FlowNode[] = [];
		const seen = new Set<string>();

		const register = (node: FlowNode): NodeRef<any> => {
			assertNodeId(node.id);
			if (seen.has(node.id)) throw new InvalidFlowError(`duplicate node id: ${node.id}`);
			seen.add(node.id);
			// 宣言済みのノードしか変数で参照できないので,循環は構文的に起きない
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
					job: jobOptionsOf(options as NodeJobOptions),
					input: options.input as InputFn,
					...(options.concurrencyKey !== undefined ? { concurrencyKey: options.concurrencyKey as string | ConcurrencyKeyFn } : {}),
				});
			},
			fanOut(id: string, binding: string, options: Record<string, any>) {
				return register({
					id,
					binding,
					container: true,
					after: refIds(options.after as Refs | undefined),
					job: jobOptionsOf(options as NodeJobOptions),
					// fan-outノードはジョブを実行しないのでpayloadを組み立てない
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
		return { nodes };
	};
}
