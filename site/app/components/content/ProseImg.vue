<script setup lang="ts">
const props = defineProps<ProseImageProps>();
</script>

<template>
	<img :src="props.src" :alt="props.alt" :width="props.width" :height="props.height" loading="lazy" />
</template>

<style scoped>
img {
	max-width: 100%;
	height: auto;
	margin-block: 1.25rem;
	border: 1px solid var(--color-divider);
	border-radius: 0.5rem;
}
</style>
