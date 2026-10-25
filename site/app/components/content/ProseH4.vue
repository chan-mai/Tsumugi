<script setup lang="ts">
const props = defineProps<ProseHeadingProps>();
</script>

<template>
	<h4 :id="props.id">
		<a v-if="props.id" :href="`#${props.id}`"><slot /></a>
		<slot v-else />
	</h4>
</template>

<style scoped>
h4 {
	margin-block: 2rem 0.75rem;
	font-size: 1.05rem;
	font-weight: 700;
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
