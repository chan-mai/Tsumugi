import { assertNodeId, shapeOf, type AnyFlow, type FlowNode, type InputOf } from '../core/flow.js';
import { advance, type NodeState, type NodeView } from '../core/run.js';

/**
 * flow定義を通しで動かす
 *
 * Durable ObjectもQueuesも起動せず, 進行の判断は本番と同じ`advance`に委ねる
 * performは実行しないので, 各ノードの結果は呼び出し側が与える
 * spawnはperformの実行時にしか決まらないため扱わない
 */

/** 実行されたノード1件ぶんの記録 */
export type SimulatedNode = {
	id: string;
	binding: string;
	/** fan-outノードは子を展開するだけなのでundefined */
	payload: unknown;
	state: NodeState;
	/** fan-outノードは子の集計値, それ以外は`results`が返した値 */
	result: unknown;
	/** fan-outで展開された子は親のノードID */
	parent: string | null;
};

/** ノードの結果を決める, 指定が無いノードはundefinedを返したものとして扱う */
export type ResultSource = Record<string, unknown> | ((node: { id: string; binding: string; payload: unknown }) => unknown);

export type SimulateOptions = {
	results?: ResultSource;
	/** 失敗させるノードID, 下流はSKIPPEDになる */
	fails?: readonly string[];
};

export type SimulationResult = {
	/** 実行順のノード, fan-outの子は展開された順に入る */
	nodes: SimulatedNode[];
	state: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
};

/** 進行が止まるまで回す上限, グラフの深さぶん回れば足りる */
const ROUNDS = 1_000;

const resultOf = (source: ResultSource | undefined, node: { id: string; binding: string; payload: unknown }): unknown => {
	if (typeof source === 'function') return source(node);
	return source?.[node.id];
};

export function simulateFlow<F extends AnyFlow>(flow: F, input: InputOf<F>, options: SimulateOptions = {}): SimulationResult {
	const fails = new Set(options.fails ?? []);
	const definitions = new Map(flow.nodes.map((node) => [node.id, node]));

	const views: NodeView[] = shapeOf(flow).map((node) => ({
		id: node.id,
		state: 'PENDING',
		container: node.container,
		parent: null,
		origin: 'static',
		after: node.after,
	}));
	const byId = new Map(views.map((view) => [view.id, view]));
	/** 実行時に確定した子ノードのpayloadと投入先 */
	const children = new Map<string, { binding: string; payload: unknown }>();
	const results = new Map<string, unknown>();
	const executed: SimulatedNode[] = [];

	/** 写像関数へ渡す受け取り口, `after`のキーをそのまま名前にする */
	const depsOf = (definition: FlowNode) =>
		Object.fromEntries(Object.entries(definition.after).map(([name, id]) => [name, results.get(id)]));

	const settle = (view: NodeView, node: Omit<SimulatedNode, 'state' | 'result'>, state: NodeState, result: unknown) => {
		view.state = state;
		results.set(view.id, result);
		executed.push({ ...node, state, result });
	};

	for (let round = 0; round < ROUNDS; round++) {
		const { decisions } = advance({ nodes: views, cancelling: false });
		if (decisions.length === 0) break;

		for (const decision of decisions) {
			const view = byId.get(decision.id);
			if (!view) continue;
			const definition = definitions.get(decision.id);

			switch (decision.type) {
				case 'start': {
					const child = children.get(view.id);
					const binding = child?.binding ?? definition?.binding ?? '';
					const payload = child ? child.payload : definition?.input(input, depsOf(definition));
					const base = { id: view.id, binding, payload, parent: view.parent };
					const failed = fails.has(view.id);
					settle(view, base, failed ? 'FAILED' : 'COMPLETED', failed ? undefined : resultOf(options.results, base));
					break;
				}

				case 'expand': {
					// 件数だけが実行時に決まる, 子のpayloadはここで確定する(ADR-0032)
					if (!definition?.over || !definition.item) break;
					const items = definition.over(input, depsOf(definition));
					items.forEach((item, index) => {
						const key = definition.key ? definition.key(item, index) : String(index);
						assertNodeId(key);
						const id = `${view.id}:${key}`;
						children.set(id, { binding: definition.binding, payload: definition.item?.(item, input, index) });
						const child: NodeView = { id, state: 'PENDING', container: false, parent: view.id, origin: 'fanOut', after: [] };
						views.push(child);
						byId.set(id, child);
					});
					view.state = 'RUNNING';
					break;
				}

				case 'aggregate': {
					// fan-outノードはジョブを実行しないので, 子の成否の集計値が戻り値になる(ADR-0035)
					const kids = views.filter((node) => node.parent === view.id);
					const succeeded = kids.filter((node) => node.state === 'COMPLETED').length;
					const summary = { total: kids.length, succeeded, failed: kids.length - succeeded };
					settle(view, { id: view.id, binding: definition?.binding ?? '', payload: undefined, parent: null }, 'COMPLETED', summary);
					break;
				}

				case 'skip': {
					const base = { id: view.id, binding: children.get(view.id)?.binding ?? definition?.binding ?? '', payload: undefined };
					settle(view, { ...base, parent: view.parent }, 'SKIPPED', undefined);
					break;
				}

				case 'cancel':
					break;
			}
		}
	}

	return { nodes: executed, state: advance({ nodes: views, cancelling: false }).state };
}
