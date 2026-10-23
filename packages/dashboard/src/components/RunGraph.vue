<script setup lang="ts">
import { Scan, ZoomIn, ZoomOut } from '@lucide/vue';
import { MarkerType, useVueFlow, VueFlow } from '@vue-flow/core';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import RunChildNode from './graph/RunChildNode.vue';
import RunEdge from './graph/RunEdge.vue';
import { HANDLE_TOP, runLayout, type ChildData, type TaskData } from './graph/runLayout';
import RunTaskNode from './graph/RunTaskNode.vue';
import type { RunNode } from '../api';

const props = defineProps<{ nodes: RunNode[] }>();
const emit = defineEmits<{ (event: 'select', jobId: string): void; (event: 'run', runId: string): void }>();
const { t } = useI18n();

const measured = ref(new Map<string, number>());
const graph = computed(() => runLayout(props.nodes, measured.value));

function measure(id: string, height: number): void {
	const rounded = Math.ceil(height);
	if (measured.value.get(id) === rounded) return;
	measured.value = new Map(measured.value).set(id, rounded);
}

// 消えたノードの実寸は破棄, Run再表示ごとの増加防止
watch(
	() => props.nodes.map((node) => node.id).join('|'),
	() => {
		const alive = new Set(props.nodes.map((node) => node.id));
		if ([...measured.value.keys()].every((id) => alive.has(id))) return;
		measured.value = new Map([...measured.value].filter(([id]) => alive.has(id)));
	},
);

const { fitView, zoomIn, zoomOut, onNodesInitialized, findNode } = useVueFlow();

const controls = [
	{ label: 'graph.zoomOut', icon: ZoomOut, action: () => void zoomOut() },
	{ label: 'graph.zoomIn', icon: ZoomIn, action: () => void zoomIn() },
	{ label: 'graph.fitView', icon: Scan, action: () => void fitView({ padding: 0.15, maxZoom: 1 }) },
];

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

// ノードの構成が変わった時だけ再調整, 状態の更新では視点を維持
const shape = computed(() => graph.value.nodes.map((node) => node.id).join('|'));
let fitted: string | null = null;

onNodesInitialized(() => {
	if (fitted === shape.value) return;
	fitted = shape.value;
	// ノード少数時の過剰拡大防止
	void fitView({ padding: 0.15, maxZoom: 1 });
});
</script>

<template>
	<div class="relative h-[50vh] min-h-72 overflow-hidden rounded-2xl border border-line bg-canvas">
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

		<div class="absolute right-3 bottom-3 flex overflow-hidden rounded-lg border border-line-strong bg-surface">
			<button
				v-for="control in controls"
				:key="control.label"
				type="button"
				class="flex size-8 items-center justify-center border-none bg-transparent text-ink-muted transition-colors not-last:border-r not-last:border-line hover:bg-canvas hover:text-ink"
				:aria-label="t(control.label)"
				:title="t(control.label)"
				@click="control.action"
			>
				<component :is="control.icon" class="size-4" aria-hidden="true" />
			</button>
		</div>
	</div>
</template>
