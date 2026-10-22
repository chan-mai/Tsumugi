import { Graph, layout } from '@dagrejs/dagre';
import type { RunNode } from '../../api';

// w-64相当
const NODE_W = 256;
const HEAD_H = 44;
const ERROR_H = 40;
const ACTION_H = 24;
const SUMMARY_H = 24;
// p-3相当
const PAD = 12;
const CHILD_W = 132;
const CHILD_H = 26;
const CHILD_GAP = 6;
const MAX_COLS = 4;

export const MAX_CHIPS = 24;

export const HANDLE_TOP = 34;

export type TaskData = {
	node: RunNode;
	/** fan-outノード以外はnull(ADR-0035) */
	progress: string | null;
	summary: string | null;
};

export type ChildData = {
	node: RunNode;
	/** 子IDの`親:`以降 */
	label: string;
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
		route: Point[];
	};
};

export type RunLayout = { nodes: LayoutNode[]; edges: LayoutEdge[] };

// 要対応の状態を優先表示
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

const colsFor = (count: number) => Math.min(MAX_COLS, Math.max(1, Math.ceil(Math.sqrt(count))));

type Packed = {
	node: RunNode;
	width: number;
	height: number;
	data: TaskData;
	children: { node: RunNode; x: number; y: number; nested: number }[];
};

function summarize(children: readonly RunNode[], hidden: number): string | null {
	if (hidden === 0) return null;
	const counts = new Map<string, number>();
	for (const child of children) counts.set(child.state, (counts.get(child.state) ?? 0) + 1);
	const parts = [...counts.entries()].sort((a, b) => attentionOf(a[0]) - attentionOf(b[0]) || a[0].localeCompare(b[0]));
	return `${parts.map(([state, count]) => `${state} ${count}`).join(' / ')} (+${hidden} hidden)`;
}

function pack(node: RunNode, childrenOf: (id: string) => RunNode[], measured: number | undefined): Packed {
	const children = childrenOf(node.id);
	const done = children.filter((child) => child.state === 'COMPLETED').length;
	const progress = node.container && children.length > 0 ? `${done} / ${children.length}` : null;

	// 孫は描画せず, 子のチップに件数のみ表示(ADR-0032)
	const shown = [...children].sort((a, b) => attentionOf(a.state) - attentionOf(b.state) || a.position - b.position).slice(0, MAX_CHIPS);
	const hidden = children.length - shown.length;
	const summary = summarize(children, hidden);

	// 計測前は見積もり, 折り返しは描画まで不明
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

type Box = { x: number; y: number; w: number; h: number; rank: number };

// ノード重なり時も縦の区間を確保
const MIN_GUTTER = 24;

type Gutter = { left: number; right: number };

// 横の区間の高さはdagreの値, ランクを跨ぐ辺とノードの重なり回避
function route(pairs: readonly [string, string][], boxes: ReadonlyMap<string, Box>, lanes: ReadonlyMap<string, Point[]>): LayoutEdge[] {
	// dagreのrankは非連番, 整列して列番号へ変換
	const ranks = [...new Set([...boxes.values()].map((box) => box.rank))].sort((a, b) => a - b);
	const rankOf = new Map([...boxes].map(([id, box]) => [id, ranks.indexOf(box.rank)]));

	const gutters: Gutter[] = [];
	for (let i = 0; i + 1 < ranks.length; i++) {
		const left = Math.max(...[...boxes.values()].filter((box) => box.rank === ranks[i]).map((box) => box.x + box.w));
		const right = Math.min(...[...boxes.values()].filter((box) => box.rank === ranks[i + 1]).map((box) => box.x));
		gutters.push(right - left >= MIN_GUTTER ? { left, right } : { left, right: left + MIN_GUTTER });
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

	// 同じ空きでの縦の区間重なり回避用
	const crossing = gutters.map(() => [] as string[]);
	for (const [from, to] of pairs) {
		const id = `${from}->${to}`;
		for (let i = rankOf.get(from)!; i < rankOf.get(to)!; i++) crossing[i]!.push(id);
	}
	for (const ids of crossing) ids.sort((a, b) => anchors.get(a)!.start.y - anchors.get(b)!.start.y || a.localeCompare(b));

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
			const next = i + 1 < last ? (lanes.get(id)?.[i - first]?.y ?? end.y) : end.y;
			points.push({ x, y }, { x, y: next });
			y = next;
		}

		// 同じ列, 後ろ向きの辺は空きを経由しない, 縦の区間1つで斜線回避
		if (last <= first) {
			const x = end.x > start.x ? (start.x + end.x) / 2 : start.x + MIN_GUTTER;
			points.push({ x, y: start.y }, { x, y: end.y });
		}

		points.push(end);
		return { id, source: from, target: to, type: 'routed' as const, data: { route: points } };
	});
}

/** `measured`はノードIDごとのカード内容の実寸 */
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
	const packed = roots.map((node) => pack(node, childrenOf, measured?.get(node.id)));
	const known = new Set(roots.map((node) => node.id));

	const graph = new Graph({ directed: true, compound: false, multigraph: false });
	// 辺の経路用に間隔広め
	graph.setGraph({ rankdir: 'LR', nodesep: 32, ranksep: 80, marginx: 16, marginy: 16 });
	graph.setDefaultEdgeLabel(() => ({}));

	for (const item of packed) graph.setNode(item.node.id, { width: item.width, height: item.height });

	const pairs: [string, string][] = [];
	const seen = new Set<string>();
	for (const node of roots) {
		for (const from of node.after) {
			// 消えた依存, 子への依存, 自己依存, 重複は辺から除外
			if (!known.has(from) || from === node.id || seen.has(`${from}->${node.id}`)) continue;
			seen.add(`${from}->${node.id}`);
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
				{ x: placed.x - item.width / 2, y: placed.y - item.height / 2, w: item.width, h: item.height, rank: placed.rank ?? 0 },
			];
		}),
	);

	const edges = route(
		pairs,
		boxes,
		new Map(
			pairs.map(([from, to]) => [`${from}->${to}`, (graph.edge(from, to)?.points ?? []).slice(1, -1).map((p) => ({ x: p.x, y: p.y }))]),
		),
	);

	const laid: LayoutNode[] = [];
	for (const item of packed) {
		const box = boxes.get(item.node.id)!;
		laid.push({
			id: item.node.id,
			type: 'task',
			position: { x: box.x, y: box.y },
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
