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
	const at = (x: number, y: number) => [(x - base.left) / scale, (y - base.top) / scale] as const;
	const next: string[] = [];
	for (const node of roots.value) {
		for (const from of node.after) {
			const source = cards.get(from);
			const target = cards.get(node.id);
			if (!source || !target) continue;
			const a = source.getBoundingClientRect();
			const b = target.getBoundingClientRect();
			const [x1, y1] = at(a.right, a.top + a.height / 2);
			const [x2, y2] = at(b.left, b.top + b.height / 2);
			const mid = x1 + (x2 - x1) / 2;
			next.push(`M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`);
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
