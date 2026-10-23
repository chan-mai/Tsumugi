<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps<{ state: string }>();
const { t, te } = useI18n();

const TONE: Record<string, string> = {
	SCHEDULED: 'bg-caution-soft text-caution',
	QUEUED: 'bg-caution-soft text-caution',
	RUNNING: 'bg-info-soft text-info-strong',
	COMPLETED: 'bg-positive-soft text-positive',
	FAILED: 'bg-critical-soft text-critical',
	CANCELLED: 'bg-neutral-soft text-ink-muted',
	STALLED: 'bg-critical-soft text-critical',
	// DAGノード専用の状態(ADR-0032)
	PENDING: 'bg-neutral-soft text-ink-muted',
	SKIPPED: 'bg-neutral-soft text-ink-muted',
};

const tone = computed(() => TONE[props.state] ?? 'bg-neutral-soft text-ink-muted');
const label = computed(() => (te(`state.${props.state}`) ? t(`state.${props.state}`) : props.state));
</script>

<template>
	<span class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap" :class="tone">
		<span class="size-1.5 rounded-full bg-current" :class="state === 'RUNNING' ? 'animate-pulse' : ''" aria-hidden="true" />
		{{ label }}
	</span>
</template>
