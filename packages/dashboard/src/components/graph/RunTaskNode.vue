<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core';
import StatusCell from '../StatusCell.vue';
import { HANDLE_TOP, type TaskData } from './runLayout';

const props = defineProps<{ data: TaskData }>();
const emit = defineEmits<{ (event: 'select', jobId: string): void }>();

// 箱の寸法はレイアウトが決めるので, 高さの合わない中身を入れない
const node = props.data.node;
</script>

<template>
	<!-- 辺は頭の行に刺す, 子で箱が伸びても中心へ寄らない -->
	<Handle type="target" :position="Position.Left" :connectable="false" :style="{ top: `${HANDLE_TOP}px` }" />
	<Handle type="source" :position="Position.Right" :connectable="false" :style="{ top: `${HANDLE_TOP}px` }" />

	<div class="size-full overflow-hidden rounded-card border border-border bg-background p-3 text-left">
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
			class="nodrag nopan mt-2 border-none text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
			@click="emit('select', node.job_id)"
		>
			Job
		</button>
		<!-- 描き切れない子は状態ごとの件数で出す(ADR-0035) -->
		<p v-if="data.summary" class="mt-2 truncate text-xs tabular-nums text-muted-foreground">{{ data.summary }}</p>
	</div>
</template>
