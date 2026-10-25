<script setup lang="ts">
useHead({ titleTemplate: (title) => (title && title !== 'Tsumugi Docs' ? `${title} | Tsumugi Docs` : 'Tsumugi Docs') });
</script>

<template>
	<NuxtLayout>
		<NuxtPage />
	</NuxtLayout>
</template>
