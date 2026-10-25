<script setup lang="ts">
const props = defineProps<{ text: string }>();
// バッククォートで囲んだ部分をコードとして表示
const segments = computed(() => props.text.split('`').map((value, index) => ({ value, code: index % 2 === 1 })));
</script>

<template>
	<template v-for="(segment, i) in segments" :key="i">
		<code v-if="segment.code" class="rounded bg-default-soft px-1 font-mono text-[0.9em] text-brand-1">{{ segment.value }}</code>
		<template v-else>{{ segment.value }}</template>
	</template>
</template>
