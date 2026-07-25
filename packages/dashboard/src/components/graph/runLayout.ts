import { Graph, layout } from '@dagrejs/dagre';
import type { RunNode } from '../../api';

/**
 * Runのグラフの配置
 *
 * ルートノードの箱の寸法をこちらで決め,その寸法でdagreに並べさせる
 * 実行時に増えた子は親の中に入れるので(ADR-0032),箱の高さは子の件数から決まる
 * 描画の実寸を測らずに座標を出せるので,この関数だけで検査できる
 */

/** カードの幅, 現行のw-64と同じ */
const NODE_W = 256;
/** IDとbindingの行 + 状態と進捗の行 */
const HEAD_H = 44;
/** 2行で切るerror */
const ERROR_H = 40;
/** Jobボタン */
const ACTION_H = 24;
/** 省略した子の内訳 */
const SUMMARY_H = 24;
/** カードの内側余白, p-3と同じ */
const PAD = 12;
const CHILD_W = 132;
const CHILD_H = 26;
const CHILD_GAP = 6;
const MAX_COLS = 4;

/** 個別に描く子の上限, 超えた分は内訳へ畳む */
export const MAX_CHIPS = 24;

/** 入れ子を描く深さ, spawnは子からも起きるので際限がない(ADR-0032) */
const MAX_DEPTH = 2;

/** 辺が刺さる高さ, 子で箱が伸びても頭の行に合わせる */
export const HANDLE_TOP = 34;

export type TaskData = {
	node: RunNode;
	/** fan-outノードの進捗, 通常ノードはnull(ADR-0035) */
	progress: string | null;
	/** 省略した子の内訳, 省略が無ければnull */
	summary: string | null;
};

export type ChildData = {
	node: RunNode;
	/** 親の下での名前, 子IDは`親:名前` */
	label: string;
	/** 更に子を持つ場合の件数, 持たなければ0 */
	nested: number;
};

export type LayoutNode = {
	id: string;
	type: 'task' | 'child';
	position: { x: number; y: number };
	style: { width: string; height: string };
	data: TaskData | ChildData;
	parentNode?: string;
	extent?: 'parent';
};

export type Point = { x: number; y: number };

export type LayoutEdge = {
	id: string;
	source: string;
	target: string;
	type: 'routed';
	data: {
		/** 水平と垂直だけで組んだ経路, 端点は箱の縁 */
		route: Point[];
	};
};

export type RunLayout = { nodes: LayoutNode[]; edges: LayoutEdge[] };

/** 描く子を選ぶ順, 手当てが要るものを先に見せる */
const ATTENTION: Record<string, number> = {
	FAILED: 0,
	STALLED: 1,
	RUNNING: 2,
	CANCELLED: 3,
	SKIPPED: 3,
	QUEUED: 4,
	SCHEDULED: 4,
	PENDING: 4,
	COMPLETED: 5,
};

const attentionOf = (state: string) => ATTENTION[state] ?? 4;

/** 格子の列数, 件数の平方根に寄せて縦横の比を保つ */
const colsFor = (count: number) => Math.min(MAX_COLS, Math.max(1, Math.ceil(Math.sqrt(count))));

type Packed = {
	node: RunNode;
	width: number;
	height: number;
	data: TaskData;
	/** 箱の中に置く子, 相対座標を持つ */
	children: { node: RunNode; x: number; y: number; nested: number }[];
};

/** 状態ごとの件数, 省略した子の代わりに出す */
function summarize(children: readonly RunNode[], hidden: number): string | null {
	if (hidden === 0) return null;
	const counts = new Map<string, number>();
	for (const child of children) counts.set(child.state, (counts.get(child.state) ?? 0) + 1);
	const parts = [...counts.entries()].sort((a, b) => attentionOf(a[0]) - attentionOf(b[0]) || a[0].localeCompare(b[0]));
	return `${parts.map(([state, count]) => `${state} ${count}`).join(' / ')} (+${hidden} hidden)`;
}

/** 箱の寸法と子の相対座標を決める */
function pack(node: RunNode, childrenOf: (id: string) => RunNode[], depth: number, measured: number | undefined): Packed {
	const children = childrenOf(node.id);
	const done = children.filter((child) => child.state === 'COMPLETED').length;
	const progress = node.container && children.length > 0 ? `${done} / ${children.length}` : null;

	// 深さの上限に達したら中身は描かない, 件数だけ親のラベルに残す
	const shown =
		depth >= MAX_DEPTH
			? []
			: [...children].sort((a, b) => attentionOf(a.state) - attentionOf(b.state) || a.position - b.position).slice(0, MAX_CHIPS);
	const hidden = children.length - shown.length;
	const summary = summarize(children, hidden);

	// 実寸が届くまでは見積もりで置く, 文字の折り返しは実際に描くまで分からない
	const content = measured ?? HEAD_H + (node.error ? ERROR_H : 0) + (node.job_id ? ACTION_H : 0) + (summary ? SUMMARY_H : 0);
	const head = PAD + content + PAD;
	if (shown.length === 0) return { node, width: NODE_W, height: head, data: { node, progress, summary }, children: [] };

	const cols = colsFor(shown.length);
	const rows = Math.ceil(shown.length / cols);
	const width = Math.max(NODE_W, cols * CHILD_W + (cols - 1) * CHILD_GAP + 2 * PAD);
	const height = head + rows * CHILD_H + (rows - 1) * CHILD_GAP + PAD;

	return {
		node,
		width,
		height,
		data: { node, progress, summary },
		children: shown.map((child, index) => ({
			node: child,
			x: PAD + (index % cols) * (CHILD_W + CHILD_GAP),
			y: head + Math.floor(index / cols) * (CHILD_H + CHILD_GAP),
			nested: childrenOf(child.id).length,
		})),
	};
}

type Box = { x: number; y: number; w: number; h: number; center: number };

/** 列と列の間の空き, 縦に走る区間はここに置く */
type Gutter = { left: number; right: number };

/**
 * 直交の経路を組む
 *
 * 縦に走るのは列の間だけに限り, 同じ空きを使う辺は等間隔に振り分ける
 * 横に走る高さはdagreが空けた値を使う, ランクを跨ぐ辺が箱に当たらない
 */
function route(pairs: readonly [string, string][], boxes: ReadonlyMap<string, Box>, lanes: ReadonlyMap<string, Point[]>): LayoutEdge[] {
	const centers = [...new Set([...boxes.values()].map((box) => box.center))].sort((a, b) => a - b);
	const rankOf = new Map([...boxes].map(([id, box]) => [id, centers.indexOf(box.center)]));

	// 列ごとの外周から, 間の空きを出す
	const gutters: Gutter[] = [];
	for (let i = 0; i + 1 < centers.length; i++) {
		const left = Math.max(...[...boxes.values()].filter((box) => box.center === centers[i]).map((box) => box.x + box.w));
		const right = Math.min(...[...boxes.values()].filter((box) => box.center === centers[i + 1]).map((box) => box.x));
		gutters.push({ left, right });
	}

	const anchors = new Map(
		pairs.map(([from, to]) => {
			const source = boxes.get(from)!;
			const target = boxes.get(to)!;
			return [
				`${from}->${to}`,
				{ start: { x: source.x + source.w, y: source.y + HANDLE_TOP }, end: { x: target.x, y: target.y + HANDLE_TOP } },
			];
		}),
	);

	// 空きごとに通る辺を集める, 同じ空きに複数入ると縦の区間が重なる
	const crossing = gutters.map(() => [] as string[]);
	for (const [from, to] of pairs) {
		const id = `${from}->${to}`;
		for (let i = rankOf.get(from)!; i < rankOf.get(to)!; i++) crossing[i]!.push(id);
	}
	for (const ids of crossing) ids.sort((a, b) => anchors.get(a)!.start.y - anchors.get(b)!.start.y || a.localeCompare(b));

	/** 空きの中での縦の走り位置, 通る本数で等分する */
	const channel = (index: number, id: string): number => {
		const gutter = gutters[index]!;
		const ids = crossing[index]!;
		return gutter.left + ((gutter.right - gutter.left) * (ids.indexOf(id) + 1)) / (ids.length + 1);
	};

	return pairs.map(([from, to]) => {
		const id = `${from}->${to}`;
		const { start, end } = anchors.get(id)!;
		const first = rankOf.get(from)!;
		const last = rankOf.get(to)!;
		const points: Point[] = [start];
		let y = start.y;

		for (let i = first; i < last; i++) {
			const x = channel(i, id);
			// 次に横切る列の高さ, 手前の列を出たらdagreが空けた高さへ移る
			const next = i + 1 < last ? (lanes.get(id)?.[i - first]?.y ?? end.y) : end.y;
			points.push({ x, y }, { x, y: next });
			y = next;
		}

		points.push(end);
		return { id, source: from, target: to, type: 'routed' as const, data: { route: points } };
	});
}

/**
 * RunのノードからVue Flowのnodesとedgesを作る
 * `measured`はカードの中身の実寸, 描画側から届いた時点で見積もりを置き換える
 */
export function runLayout(nodes: readonly RunNode[], measured?: ReadonlyMap<string, number>): RunLayout {
	if (nodes.length === 0) return { nodes: [], edges: [] };

	const byParent = new Map<string, RunNode[]>();
	for (const node of nodes) {
		if (node.parent === null) continue;
		const siblings = byParent.get(node.parent);
		if (siblings) siblings.push(node);
		else byParent.set(node.parent, [node]);
	}
	const childrenOf = (id: string) => byParent.get(id) ?? [];

	const roots = nodes.filter((node) => node.parent === null);
	const packed = roots.map((node) => pack(node, childrenOf, 0, measured?.get(node.id)));
	const known = new Set(roots.map((node) => node.id));

	const graph = new Graph({ directed: true, compound: false, multigraph: false });
	// LRは現行の左から右への並びと同じ, 辺が箱の間を通るので間隔は広めに取る
	graph.setGraph({ rankdir: 'LR', nodesep: 32, ranksep: 80, marginx: 16, marginy: 16 });
	graph.setDefaultEdgeLabel(() => ({}));

	for (const item of packed) graph.setNode(item.node.id, { width: item.width, height: item.height });

	const pairs: [string, string][] = [];
	for (const node of roots) {
		for (const from of node.after) {
			// 消えた依存や子を指す依存は辺にしない
			if (!known.has(from)) continue;
			graph.setEdge(from, node.id);
			pairs.push([from, node.id]);
		}
	}

	layout(graph);

	const boxes = new Map<string, Box>(
		packed.map((item) => {
			const placed = graph.node(item.node.id);
			return [
				item.node.id,
				{ x: placed.x - item.width / 2, y: placed.y - item.height / 2, w: item.width, h: item.height, center: placed.x },
			];
		}),
	);

	const edges = route(
		pairs,
		boxes,
		// dagreがランクごとに空けた高さ, 箱を避けて横切れる
		new Map(
			pairs.map(([from, to]) => [`${from}->${to}`, (graph.edge(from, to)?.points ?? []).slice(1, -1).map((p) => ({ x: p.x, y: p.y }))]),
		),
	);

	const laid: LayoutNode[] = [];
	for (const item of packed) {
		const placed = graph.node(item.node.id);
		// dagreが返すのは箱の中心, Vue Flowは左上で受ける
		const position = { x: placed.x - item.width / 2, y: placed.y - item.height / 2 };
		laid.push({
			id: item.node.id,
			type: 'task',
			position,
			style: { width: `${item.width}px`, height: `${item.height}px` },
			data: item.data,
		});

		for (const child of item.children) {
			laid.push({
				id: child.node.id,
				type: 'child',
				parentNode: item.node.id,
				extent: 'parent',
				// 子の座標は親からの相対
				position: { x: child.x, y: child.y },
				style: { width: `${CHILD_W}px`, height: `${CHILD_H}px` },
				data: { node: child.node, label: child.node.id.slice(item.node.id.length + 1), nested: child.nested },
			});
		}
	}

	return { nodes: laid, edges };
}
