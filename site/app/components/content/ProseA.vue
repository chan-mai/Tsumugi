<script setup lang="ts">
const props = defineProps<ProseLinkProps>();
</script>

<template>
	<NuxtLink :href="props.href" :target="props.target"><slot /></NuxtLink>
</template>

<style scoped>
a {
	color: var(--color-brand-1);
	font-weight: 500;
	text-decoration: underline;
	text-decoration-color: color-mix(in srgb, var(--color-brand-1) 40%, transparent);
	text-underline-offset: 0.2em;
	transition: text-decoration-color 0.2s;
}

a:hover {
	text-decoration-color: var(--color-brand-1);
}
</style>
