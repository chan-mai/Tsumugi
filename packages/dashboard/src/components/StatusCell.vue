<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ state: string }>();

/** 状態ごとの見え方,バッジではなくアイコンと文字で表す */
const STATES: Record<string, { label: string; color: string; mark: string; pulse?: boolean }> = {
	SCHEDULED: { label: 'Scheduled', color: 'text-yellow-500', mark: '' },
	QUEUED: { label: 'Queued', color: 'text-yellow-500', mark: 'M8 4.5v4l2.5 1.5' },
	RUNNING: { label: 'Running', color: 'text-blue-500', mark: 'M8 4.5v4l2.5 1.5', pulse: true },
	COMPLETED: { label: 'Completed', color: 'text-green-500', mark: 'M5 8.2l2.2 2.2L11 6.6' },
	FAILED: { label: 'Failed', color: 'text-red-500', mark: 'M5.5 5.5l5 5M10.5 5.5l-5 5' },
	CANCELLED: { label: 'Cancelled', color: 'text-gray-500', mark: 'M5 8h6' },
	STALLED: { label: 'Stalled', color: 'text-purple-500', mark: 'M8 4.6v4M8 10.8v.6' },
};

const view = computed(() => STATES[props.state] ?? { label: props.state, color: 'text-muted-foreground', mark: '' });
</script>

<template>
	<div class="flex items-center gap-2">
		<svg
			viewBox="0 0 16 16"
			class="size-4 shrink-0"
			:class="[view.color, view.pulse ? 'animate-pulse' : '']"
			fill="none"
			stroke="currentColor"
			stroke-width="1.3"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<circle cx="8" cy="8" r="6.4" />
			<path v-if="view.mark" :d="view.mark" />
		</svg>
		<span>{{ view.label }}</span>
	</div>
</template>
