<script setup lang="ts">
const site = useSiteConfig();
useSeoMeta({
	description: site.description,
	ogDescription: site.description,
	ogSiteName: site.name,
	ogType: 'website',
	twitterCard: 'summary_large_image',
});
useLocaleHtmlAttrs();
</script>

<template>
	<NuxtLayout>
		<NuxtPage />
	</NuxtLayout>
</template>
