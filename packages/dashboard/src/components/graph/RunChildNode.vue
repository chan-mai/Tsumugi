<script setup lang="ts">
import StatusCell from '../StatusCell.vue';
import type { ChildData } from './runLayout';

defineProps<{ data: ChildData }>();
</script>

<template>
	<!-- 子は依存を持たないので接続点を置かない(ADR-0032) -->
	<div class="flex size-full items-center justify-between gap-2 overflow-hidden rounded-card border border-border bg-muted px-2 text-xs">
		<span class="truncate text-muted-foreground">{{ data.label }}</span>
		<span class="flex shrink-0 items-center gap-1">
			<span v-if="data.nested > 0" class="tabular-nums text-muted-foreground">+{{ data.nested }}</span>
			<StatusCell :state="data.node.state" class="scale-90" />
		</span>
	</div>
</template>
