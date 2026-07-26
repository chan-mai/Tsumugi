<script setup lang="ts">
import { MarkerType, useVueFlow, VueFlow } from '@vue-flow/core';
import { computed, ref, watch } from 'vue';
import RunChildNode from './graph/RunChildNode.vue';
import RunEdge from './graph/RunEdge.vue';
import { HANDLE_TOP, runLayout, type ChildData, type TaskData } from './graph/runLayout';
import RunTaskNode from './graph/RunTaskNode.vue';
import type { RunNode } from '../api';

/**
 * Runのグラフ
 *
 * 座標は`runLayout`が決め,描画と操作はVue Flowが持つ
 * 実行時に増えたノードは親ノードの中に入る(ADR-0032)
 */
const props = defineProps<{ nodes: RunNode[] }>();
const emit = defineEmits<{ (event: 'select', jobId: string): void; (event: 'run', runId: string): void }>();

// カードの中身の実寸, 届くまでは`runLayout`の見積もりで置く
const measured = ref(new Map<string, number>());
const graph = computed(() => runLayout(props.nodes, measured.value));

function measure(id: string, height: number): void {
	const rounded = Math.ceil(height);
	if (measured.value.get(id) === rounded) return;
	measured.value = new Map(measured.value).set(id, rounded);
}

// 消えたノードの実寸は捨てる, 残すとRunを開き直すたびに溜まる
watch(
	() => props.nodes.map((node) => node.id).join('|'),
	() => {
		const alive = new Set(props.nodes.map((node) => node.id));
		if ([...measured.value.keys()].every((id) => alive.has(id))) return;
		measured.value = new Map([...measured.value].filter(([id]) => alive.has(id)));
	},
);

const { fitView, zoomIn, zoomOut, onNodesInitialized, findNode } = useVueFlow();

/**
 * ドラッグに追従させた辺
 * 端の区間だけを動いた位置へ寄せ, 途中の経路はレイアウトのまま保つ
 */
const edges = computed(() =>
	graph.value.edges.map((edge) => {
		const route = edge.data.route.map((point) => ({ ...point }));
		const source = findNode(edge.source);
		const target = findNode(edge.target);
		const first = route[0];
		const last = route[route.length - 1];
		if (source && first && route[1]) {
			first.x = source.position.x + (source.dimensions.width || Number.parseFloat(source.style?.width as string) || 0);
			first.y = source.position.y + HANDLE_TOP;
			route[1].y = first.y;
		}
		if (target && last && route[route.length - 2]) {
			last.x = target.position.x;
			last.y = target.position.y + HANDLE_TOP;
			route[route.length - 2]!.y = last.y;
		}
		return { ...edge, data: { route } };
	}),
);

// ノードの顔ぶれが変わった時だけ合わせ直す, 状態の更新で視点を奪わない
const shape = computed(() => graph.value.nodes.map((node) => node.id).join('|'));
let fitted: string | null = null;

onNodesInitialized(() => {
	if (fitted === shape.value) return;
	fitted = shape.value;
	// ノードが少ないRunで拡大されすぎないよう上限を置く
	void fitView({ padding: 0.15, maxZoom: 1 });
});
</script>

<template>
	<div class="relative h-[50vh] min-h-72 overflow-hidden rounded-card border border-border bg-muted/30">
		<VueFlow
			:nodes="graph.nodes"
			:edges="edges"
			:nodes-draggable="true"
			:nodes-connectable="false"
			:elements-selectable="false"
			:zoom-on-scroll="false"
			:zoom-on-double-click="false"
			:prevent-scrolling="false"
			:min-zoom="0.05"
			:max-zoom="1.5"
			:default-edge-options="{ markerEnd: MarkerType.ArrowClosed }"
			:only-render-visible-elements="true"
		>
			<template #node-task="{ data }">
				<RunTaskNode :data="data as TaskData" @select="emit('select', $event)" @run="emit('run', $event)" @measure="measure" />
			</template>
			<template #node-child="{ data }">
				<RunChildNode :data="data as ChildData" />
			</template>
			<template #edge-routed="edge">
				<RunEdge v-bind="edge" />
			</template>
		</VueFlow>

		<div class="absolute right-2 bottom-2 flex gap-1">
			<button type="button" class="rounded-card border border-border bg-background px-2 py-1 text-xs" aria-label="縮小" @click="zoomOut()">
				-
			</button>
			<button type="button" class="rounded-card border border-border bg-background px-2 py-1 text-xs" aria-label="拡大" @click="zoomIn()">
				+
			</button>
			<button
				type="button"
				class="rounded-card border border-border bg-background px-2 py-1 text-xs"
				aria-label="全体を表示"
				@click="fitView({ padding: 0.15, maxZoom: 1 })"
			>
				Fit
			</button>
		</div>
	</div>
</template>
