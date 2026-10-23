<script setup lang="ts">
import { ArrowDown, ArrowUp, ArrowUpDown } from '@lucide/vue';
defineProps<{ label: string; column: string; sort: string; desc: boolean }>();
const emit = defineEmits<{ sort: [column: string] }>();
</script>

<template>
	<button
		type="button"
		class="-ml-2 flex h-7 items-center gap-1 rounded-lg border-none bg-transparent px-2 text-xs font-semibold tracking-wide text-ink-muted hover:bg-neutral-soft hover:text-ink"
		@click="emit('sort', column)"
	>
		{{ label }}
		<component
			:is="sort !== column ? ArrowUpDown : desc ? ArrowDown : ArrowUp"
			class="size-3"
			:class="sort === column ? '' : 'opacity-40'"
			aria-hidden="true"
		/>
	</button>
</template>
