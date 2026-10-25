<template>
	<th><slot /></th>
</template>

<style scoped>
th {
	padding: 0.5rem 1rem;
	border: 1px solid var(--color-divider);
	background-color: var(--color-bg-soft);
	font-weight: 600;
	text-align: start;
	white-space: nowrap;
}
</style>
