<script setup lang="ts">
const props = defineProps<ProseHeadingProps>();
</script>

<template>
	<h2 :id="props.id">
		<a v-if="props.id" :href="`#${props.id}`"><slot /></a>
		<slot v-else />
	</h2>
</template>

<style scoped>
h2 {
	margin-block: 3.5rem 1.25rem;
	font-size: 1.5rem;
	font-weight: 700;
	line-height: 1.4;
}

a {
	color: inherit;
	font-weight: inherit;
	text-decoration: none;
}

a:hover::after {
	content: ' #';
	color: var(--color-brand-1);
}
</style>
