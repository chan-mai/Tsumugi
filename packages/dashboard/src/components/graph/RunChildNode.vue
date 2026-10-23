<script setup lang="ts">
import StatusCell from '../StatusCell.vue';
import type { ChildData } from './runLayout';

defineProps<{ data: ChildData }>();
</script>

<template>
	<div class="flex size-full items-center justify-between gap-2 overflow-hidden rounded-lg border border-line bg-canvas px-2 text-xs">
		<span class="truncate text-ink-subtle">{{ data.label }}</span>
		<span class="flex shrink-0 items-center gap-1">
			<span v-if="data.nested > 0" class="tabular-nums text-ink-subtle">+{{ data.nested }}</span>
			<StatusCell :state="data.node.state" class="scale-90" />
		</span>
	</div>
</template>
