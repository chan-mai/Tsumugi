<script setup lang="ts">
const props = defineProps<ProseHeadingProps>();
</script>

<template>
	<h3 :id="props.id">
		<a v-if="props.id" :href="`#${props.id}`"><slot /></a>
		<slot v-else />
	</h3>
</template>

<style scoped>
h3 {
	margin-block: 2.5rem 1rem;
	font-size: 1.25rem;
	font-weight: 700;
	line-height: 1.5;
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
