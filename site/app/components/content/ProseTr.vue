<template>
	<tr>
		<slot />
	</tr>
</template>

<style scoped>
tr:nth-child(2n) {
	background-color: color-mix(in srgb, var(--color-bg-soft) 50%, transparent);
}
</style>
