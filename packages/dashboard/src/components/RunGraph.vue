<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import StatusCell from './StatusCell.vue';
import type { RunNode } from '../api';

/**
 * runのグラフ
 *
 * 配置はflexに任せ,依存の線だけを実寸から引く
 * 実行時に増えたノードは親カードの内側に入れる(ADR-0032), 合流だけは入れ子で表せないので段で分ける
 */
const props = defineProps<{ nodes: RunNode[] }>();
const emit = defineEmits<{ (event: 'select', jobId: string): void }>();

const container = ref<HTMLElement | null>(null);
const canvas = ref<SVGSVGElement | null>(null);
const cards = new Map<string, HTMLElement>();
const paths = ref<string[]>([]);

const roots = computed(() => props.nodes.filter((node) => node.parent === null));
const childrenOf = (id: string) => props.nodes.filter((node) => node.parent === id);

/** 依存の深さで段を決める, 宣言済みしか参照できないので循環は起きない(ADR-0030) */
const columns = computed<RunNode[][]>(() => {
	const byId = new Map(roots.value.map((node) => [node.id, node]));
	const depth = new Map<string, number>();
	const depthOf = (node: RunNode): number => {
		const memo = depth.get(node.id);
		if (memo !== undefined) return memo;
		const value =
			node.after.length === 0
				? 0
				: 1 +
					Math.max(
						...node.after.map((id) => {
							const dependency = byId.get(id);
							return dependency ? depthOf(dependency) : 0;
						}),
					);
		depth.set(node.id, value);
		return value;
	};

	const result: RunNode[][] = [];
	for (const node of roots.value) {
		const at = depthOf(node);
		(result[at] ??= []).push(node);
	}
	return result.map((column) => column ?? []);
});

/** fan-outノードの進捗, 子から数える(ADR-0035) */
const progressOf = (node: RunNode) => {
	if (!node.container) return null;
	const children = childrenOf(node.id);
	if (children.length === 0) return null;
	return `${children.filter((child) => child.state === 'COMPLETED').length} / ${children.length}`;
};

function setCard(id: string, element: unknown): void {
	if (element instanceof HTMLElement) cards.set(id, element);
	else cards.delete(id);
}

type Rect = { l: number; r: number; t: number; b: number };

/** 迂回に使う隙間の下限, これ未満は通しても線が両側のカードに接する */
const MIN_GAP = 8;

/**
 * 中間の列を通す高さ, カードの隙間のうち目標に近いものを選ぶ
 * 隙間が無ければ目標のまま返す, カードの背後を通る
 */
function passY(column: Rect[], target: number, bottom: number): number {
	const gaps: [number, number][] = [];
	for (let i = 0; i + 1 < column.length; i++) gaps.push([column[i]!.b, column[i + 1]!.t]);
	const last = column[column.length - 1];
	if (last) gaps.push([last.b, bottom]);

	let best: number | null = null;
	for (const [from, to] of gaps) {
		if (to - from < MIN_GAP) continue;
		const center = (from + to) / 2;
		if (best === null || Math.abs(center - target) < Math.abs(best - target)) best = center;
	}
	return best ?? target;
}

/**
 * 1本ぶんの経路
 * 隣の列へはそのまま曲線を引く, 列を跨ぐ場合は中間の列を隙間で横切る
 */
function pathFor(a: Rect, b: Rect, between: Rect[][], bottom: number): string {
	const y1 = (a.t + a.b) / 2;
	const y2 = (b.t + b.b) / 2;
	let x = a.r;
	let y = y1;
	let d = `M${x} ${y}`;
	for (const column of between) {
		const left = Math.min(...column.map((rect) => rect.l));
		const right = Math.max(...column.map((rect) => rect.r));
		const at = passY(column, (y1 + y2) / 2, bottom);
		const mid = x + (left - x) / 2;
		d += ` C${mid} ${y} ${mid} ${at} ${left} ${at} L${right} ${at}`;
		x = right;
		y = at;
	}
	const mid = x + (b.l - x) / 2;
	return `${d} C${mid} ${y} ${mid} ${y2} ${b.l} ${y2}`;
}

/**
 * カードの実寸から線を引き直す, 位置決めをブラウザに任せているので測るしかない
 * 実寸にはモーダルの開閉アニメーションのscaleが乗るので, SVGの座標系へ戻してから使う
 */
function draw(): void {
	const root = container.value;
	const base = canvas.value?.getBoundingClientRect();
	if (!root || !base) return;
	// 縮小中の値をそのまま置くと線が縮み, 端がカードから離れる
	const scale = root.clientWidth > 0 ? base.width / root.clientWidth : 1;
	const rectOf = (id: string): Rect | null => {
		const element = cards.get(id);
		if (!element) return null;
		const r = element.getBoundingClientRect();
		return {
			l: (r.left - base.left) / scale,
			r: (r.right - base.left) / scale,
			t: (r.top - base.top) / scale,
			b: (r.bottom - base.top) / scale,
		};
	};

	const columnOf = new Map<string, number>();
	const rects: Rect[][] = [];
	columns.value.forEach((column, index) => {
		rects[index] = [];
		for (const node of column) {
			columnOf.set(node.id, index);
			const rect = rectOf(node.id);
			if (rect) rects[index]!.push(rect);
		}
	});
	const bottom = base.height / scale;

	const next: string[] = [];
	for (const node of roots.value) {
		for (const from of node.after) {
			const a = rectOf(from);
			const b = rectOf(node.id);
			const source = columnOf.get(from);
			const target = columnOf.get(node.id);
			if (!a || !b || source === undefined || target === undefined) continue;
			const between = rects.slice(source + 1, target).filter((column) => column.length > 0);
			next.push(pathFor(a, b, between, bottom));
		}
	}
	paths.value = next;
}

let observer: ResizeObserver | undefined;

onMounted(() => {
	observer = new ResizeObserver(() => draw());
	if (container.value) observer.observe(container.value);
	void nextTick(draw);
});

onBeforeUnmount(() => observer?.disconnect());

// 状態が変わるとカードの高さも変わるので, 描画が終わってから測る
watch(
	() => props.nodes,
	() => void nextTick(draw),
	{ deep: true },
);
</script>

<template>
	<div class="overflow-x-auto">
		<div ref="container" class="relative flex w-max items-start gap-10 p-2">
			<!-- 線はカードの下に敷き,操作を邪魔しない -->
			<svg ref="canvas" class="pointer-events-none absolute inset-0 size-full overflow-visible" aria-hidden="true">
				<path v-for="(d, index) in paths" :key="index" :d="d" fill="none" stroke="currentColor" stroke-width="1.5" class="text-border" />
			</svg>

			<div v-for="(column, index) in columns" :key="index" class="relative flex flex-col gap-3">
				<div
					v-for="node in column"
					:key="node.id"
					:ref="(el) => setCard(node.id, el)"
					class="w-64 rounded-card border border-border bg-background p-3"
				>
					<div class="flex items-baseline justify-between gap-2">
						<span class="truncate font-medium">{{ node.id }}</span>
						<span class="shrink-0 text-xs text-muted-foreground">{{ node.binding }}</span>
					</div>
					<div class="mt-2 flex items-center justify-between gap-2 text-sm">
						<StatusCell :state="node.state" />
						<span v-if="progressOf(node)" class="text-xs tabular-nums text-muted-foreground">{{ progressOf(node) }}</span>
					</div>
					<p v-if="node.error" class="mt-2 line-clamp-2 text-xs break-all text-destructive">{{ node.error }}</p>
					<button
						v-if="node.job_id"
						type="button"
						class="mt-2 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground border-none"
						@click="emit('select', node.job_id)"
					>
						Job
					</button>

					<!-- 実行時に増えた子は親の内側に置く(ADR-0032) -->
					<ul v-if="childrenOf(node.id).length > 0" class="mt-3 space-y-1 border-l border-border pl-3">
						<li v-for="child in childrenOf(node.id)" :key="child.id" class="flex items-center justify-between gap-2 text-xs">
							<span class="truncate text-muted-foreground">{{ child.id.slice(node.id.length + 1) }}</span>
							<StatusCell :state="child.state" class="shrink-0 scale-90" />
						</li>
					</ul>
				</div>
			</div>
		</div>
	</div>
</template>
