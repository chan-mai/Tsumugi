<script setup lang="ts">
defineProps<{ label: string; column: string; sort: string; desc: boolean }>();
const emit = defineEmits<{ sort: [column: string] }>();
</script>

<template>
	<button
		type="button"
		class="-ml-2 flex h-8 items-center gap-1 rounded-card border-none px-2 font-medium text-muted-foreground hover:bg-accent"
		@click="emit('sort', column)"
	>
		{{ label }}
		<svg
			viewBox="0 0 16 16"
			class="size-3"
			:class="sort === column ? '' : 'opacity-30'"
			fill="none"
			stroke="currentColor"
			stroke-width="1.6"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<!-- 未選択時は両向きを薄く表示,押下可能なことのみ示す -->
			<path v-if="sort !== column" d="M5 6.5L8 3.5l3 3M5 9.5l3 3 3-3" />
			<path v-else-if="desc" d="M4.5 9l3.5 3.5L11.5 9M8 12V3.5" />
			<path v-else d="M4.5 7L8 3.5 11.5 7M8 4v8.5" />
		</svg>
	</button>
</template>
