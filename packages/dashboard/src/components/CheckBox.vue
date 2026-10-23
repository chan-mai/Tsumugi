<script setup lang="ts">
import { Check } from '@lucide/vue';
defineProps<{ checked: boolean }>();
</script>

<template>
	<span
		class="flex size-4 shrink-0 items-center justify-center rounded border"
		:class="checked ? 'border-accent bg-accent text-on-accent' : 'border-line-strong bg-surface'"
	>
		<Check v-if="checked" class="size-3" :stroke-width="3" aria-hidden="true" />
	</span>
</template>
