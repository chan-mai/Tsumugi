<script setup lang="ts">
const props = defineProps<ProseHeadingProps>();
</script>

<template>
	<h1 :id="props.id">
		<slot />
	</h1>
</template>

<style scoped>
h1 {
	margin-block-end: 2rem;
	font-size: 2rem;
	font-weight: 700;
	line-height: 1.4;
	letter-spacing: -0.01em;
}
</style>
