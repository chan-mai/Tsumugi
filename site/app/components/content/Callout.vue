<script setup lang="ts">
const props = defineProps<CalloutProps>();

const tones = {
	info: 'border-info-1 bg-info-soft text-info-1',
	tip: 'border-tip-1 bg-tip-soft text-tip-1',
	warning: 'border-warning-1 bg-warning-soft text-warning-1',
	danger: 'border-danger-1 bg-danger-soft text-danger-1',
};
</script>

<template>
	<div
		class="my-5 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 rounded-lg border-2 px-5 py-4"
		:class="tones[props.type]"
		:role="props.type === 'danger' || props.type === 'warning' ? 'note' : undefined"
	>
		<svg viewBox="0 0 24 24" class="size-6" aria-hidden="true">
			<template v-if="props.type === 'tip'">
				<circle cx="12" cy="12" r="11" fill="currentColor" />
				<path
					d="m7 12.5 3.2 3.2L17 9"
					fill="none"
					stroke="var(--color-bg)"
					stroke-width="2.4"
					stroke-linecap="round"
					stroke-linejoin="round"
				/>
			</template>
			<template v-else-if="props.type === 'danger'">
				<circle cx="12" cy="12" r="11" fill="currentColor" />
				<path d="m8 8 8 8M16 8l-8 8" fill="none" stroke="var(--color-bg)" stroke-width="2.4" stroke-linecap="round" />
			</template>
			<template v-else-if="props.type === 'warning'">
				<path d="M10.3 2.9a2 2 0 0 1 3.4 0l9.2 16.1a2 2 0 0 1-1.7 3H2.8a2 2 0 0 1-1.7-3z" fill="currentColor" />
				<path d="M12 9v5" stroke="var(--color-bg)" stroke-width="2.4" stroke-linecap="round" />
				<circle cx="12" cy="17.6" r="1.4" fill="var(--color-bg)" />
			</template>
			<template v-else>
				<circle cx="12" cy="12" r="11" fill="currentColor" />
				<path d="M12 11v6" stroke="var(--color-bg)" stroke-width="2.4" stroke-linecap="round" />
				<circle cx="12" cy="7.4" r="1.5" fill="var(--color-bg)" />
			</template>
		</svg>
		<p class="font-bold">{{ props.title ?? props.type.toUpperCase() }}</p>
		<div class="body col-start-2 text-sm text-text-1">
			<slot />
		</div>
	</div>
</template>

<style scoped>
.body > :slotted(:first-child) {
	margin-block-start: 0;
}

.body > :slotted(:last-child) {
	margin-block-end: 0;
}
</style>
