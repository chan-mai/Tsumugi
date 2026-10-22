import { assertNodeId, shapeOf, type AnyFlow, type FlowNode, type InputOf } from '../core/flow.js';
import { advance, type NodeState, type NodeView } from '../core/run.js';

// performは非実行で結果は呼び出し側指定, spawnは対象外

export type SimulatedNode = {
	id: string;
	binding: string;
	/** fan-outノードは子の展開のみでundefined */
	payload: unknown;
	state: NodeState;
	/** fan-outノードは子の集計値, それ以外は`results`が返した値 */
	result: unknown;
	/** fan-outで展開された子は親ノードID */
	parent: string | null;
};

/** 未指定ノードはundefined */
export type ResultSource = Record<string, unknown> | ((node: { id: string; binding: string; payload: unknown }) => unknown);

export type SimulateOptions = {
	results?: ResultSource;
	/** 失敗させるノードID, 下流はSKIPPED */
	fails?: readonly string[];
};

export type SimulationResult = {
	/** 実行順のノード, fan-outの子は展開順 */
	nodes: SimulatedNode[];
	state: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
};

// グラフの深さ分で十分
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
		// 子のrunを起動するsubflowノードは対象外
		subflow: false,
		parent: null,
		origin: 'static',
		after: node.after,
		trigger: node.trigger,
	}));
	const byId = new Map(views.map((view) => [view.id, view]));
	const children = new Map<string, { binding: string; payload: unknown }>();
	const results = new Map<string, unknown>();
	const executed: SimulatedNode[] = [];

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

			// 判定falseは不実行, 下流は依存未成功で未開始(ADR-0041)
			if ((decision.type === 'start' || decision.type === 'expand') && definition?.when) {
				const binding = children.get(view.id)?.binding ?? definition.binding;
				const base = { id: view.id, binding, payload: undefined, parent: view.parent };
				let passed: boolean;
				try {
					passed = definition.when(input, depsOf(definition));
				} catch {
					// 判定自体の失敗はRun DOと同じくFAILED
					settle(view, base, 'FAILED', undefined);
					continue;
				}
				if (!passed) {
					settle(view, base, 'SKIPPED', undefined);
					continue;
				}
			}

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
					if (!definition?.over || !definition.item) break;
					const items = definition.over(input, depsOf(definition));
					items.forEach((item, index) => {
						const key = definition.key ? definition.key(item, index) : String(index);
						assertNodeId(key);
						const id = `${view.id}:${key}`;
						children.set(id, { binding: definition.binding, payload: definition.item?.(item, input, index) });
						const child: NodeView = {
							id,
							state: 'PENDING',
							container: false,
							subflow: false,
							parent: view.id,
							origin: 'fanOut',
							after: [],
							trigger: 'success',
						};
						views.push(child);
						byId.set(id, child);
					});
					view.state = 'RUNNING';
					break;
				}

				case 'aggregate': {
					// fan-outノードはジョブ非実行, 子の成否集計値が戻り値(ADR-0035)
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
