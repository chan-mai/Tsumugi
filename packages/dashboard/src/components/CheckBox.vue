<script setup lang="ts">
/** 選択状態の印, 押下の扱いは呼び出し側のbuttonが持つ */
defineProps<{ checked: boolean }>();
</script>

<template>
	<span class="flex size-4 shrink-0 items-center justify-center rounded-sm border border-border">
		<svg
			v-if="checked"
			viewBox="0 0 16 16"
			class="size-3"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
		>
			<path d="M3.5 8.5l3 3 6-6" />
		</svg>
	</span>
</template>
