<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import StatusCell from '../StatusCell.vue';
import { HANDLE_TOP, type TaskData } from './runLayout';

const props = defineProps<{ data: TaskData }>();
const emit = defineEmits<{
	(event: 'select', jobId: string): void;
	(event: 'run', runId: string): void;
	(event: 'measure', id: string, height: number): void;
}>();
const { t } = useI18n();

// dataは再構築ごとに別オブジェクト, 都度再取得
const node = computed(() => props.data.node);

// ノードの高さはレイアウト側, 折り返しで伸びた分は計測して通知
const content = ref<HTMLElement | null>(null);
let observer: ResizeObserver | undefined;

function observe(element: HTMLElement | null): void {
	observer?.disconnect();
	if (!element) return;
	observer = new ResizeObserver(([entry]) => {
		if (entry) emit('measure', node.value.id, entry.contentRect.height);
	});
	observer.observe(element);
}

onMounted(() => observe(content.value));
// 要素差し替え時も観測対象を更新
watch(content, observe, { flush: 'post' });

onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
	<!-- 辺の接続位置は先頭行, ノード伸長時の中心移動防止 -->
	<Handle type="target" :position="Position.Left" :connectable="false" :style="{ top: `${HANDLE_TOP}px` }" />
	<Handle type="source" :position="Position.Right" :connectable="false" :style="{ top: `${HANDLE_TOP}px` }" />

	<div class="size-full overflow-hidden rounded-xl border border-line bg-surface p-3 text-left">
		<div ref="content">
			<div class="flex items-baseline justify-between gap-2">
				<span class="truncate font-medium">{{ node.id }}</span>
				<span class="shrink-0 text-xs text-ink-subtle">{{ node.binding }}</span>
			</div>
			<div class="mt-2 flex items-center justify-between gap-2 text-sm">
				<StatusCell :state="node.state" />
				<span v-if="data.progress" class="text-xs tabular-nums text-ink-subtle">{{ data.progress }}</span>
			</div>
			<p v-if="node.error" class="mt-2 line-clamp-2 text-xs break-all text-critical">{{ node.error }}</p>
			<button
				v-if="node.job_id"
				type="button"
				class="nodrag nopan mt-2 block border-none bg-transparent text-xs text-ink-subtle underline underline-offset-2 hover:text-ink"
				@click="emit('select', node.job_id)"
			>
				{{ t('common.job') }}
			</button>
			<button
				v-if="node.child_run_id"
				type="button"
				class="nodrag nopan mt-2 block border-none bg-transparent text-xs text-ink-subtle underline underline-offset-2 hover:text-ink"
				@click="emit('run', node.child_run_id)"
			>
				{{ t('common.run') }}
			</button>
			<p v-if="data.summary" class="mt-2 truncate text-xs tabular-nums text-ink-subtle">{{ data.summary }}</p>
		</div>
	</div>
</template>
