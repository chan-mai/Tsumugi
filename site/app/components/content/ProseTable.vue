<template>
	<div class="table">
		<table>
			<slot />
		</table>
	</div>
</template>

<style scoped>
.table {
	overflow-x: auto;
	margin-block: 1.25rem;
}

table {
	border-collapse: collapse;
	font-size: 0.9rem;
	line-height: 1.6;
}
</style>
