<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core';
import { onBeforeUnmount, onMounted, ref } from 'vue';
import StatusCell from '../StatusCell.vue';
import { HANDLE_TOP, type TaskData } from './runLayout';

const props = defineProps<{ data: TaskData }>();
const emit = defineEmits<{
	(event: 'select', jobId: string): void;
	(event: 'measure', id: string, height: number): void;
}>();

const node = props.data.node;

/**
 * 中身の実寸を返す
 * 箱の高さはレイアウトが決めるので, 文字の折り返しで中身が伸びた分は測って返すしかない
 */
const content = ref<HTMLElement | null>(null);
let observer: ResizeObserver | undefined;

onMounted(() => {
	if (!content.value) return;
	observer = new ResizeObserver(([entry]) => {
		if (entry) emit('measure', node.id, entry.contentRect.height);
	});
	observer.observe(content.value);
});

onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
	<!-- 辺は頭の行に刺す, 子で箱が伸びても中心へ寄らない -->
	<Handle type="target" :position="Position.Left" :connectable="false" :style="{ top: `${HANDLE_TOP}px` }" />
	<Handle type="source" :position="Position.Right" :connectable="false" :style="{ top: `${HANDLE_TOP}px` }" />

	<div class="size-full overflow-hidden rounded-card border border-border bg-background p-3 text-left">
		<div ref="content">
			<div class="flex items-baseline justify-between gap-2">
				<span class="truncate font-medium">{{ node.id }}</span>
				<span class="shrink-0 text-xs text-muted-foreground">{{ node.binding }}</span>
			</div>
			<div class="mt-2 flex items-center justify-between gap-2 text-sm">
				<StatusCell :state="node.state" />
				<span v-if="data.progress" class="text-xs tabular-nums text-muted-foreground">{{ data.progress }}</span>
			</div>
			<p v-if="node.error" class="mt-2 line-clamp-2 text-xs break-all text-destructive">{{ node.error }}</p>
			<button
				v-if="node.job_id"
				type="button"
				class="nodrag nopan mt-2 block border-none text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
				@click="emit('select', node.job_id)"
			>
				Job
			</button>
			<!-- 描き切れない子は状態ごとの件数で出す(ADR-0035) -->
			<p v-if="data.summary" class="mt-2 truncate text-xs tabular-nums text-muted-foreground">{{ data.summary }}</p>
		</div>
	</div>
</template>
