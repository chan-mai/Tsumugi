<script setup lang="ts">
const { title, section, description } = defineProps<{ title: string; section?: string; description?: string }>();
const site = useSiteConfig();
</script>

<template>
	<div
		data-theme="light"
		class="relative flex h-full w-full flex-col justify-between overflow-hidden bg-hero-gradient-2 p-20 text-text-1"
		style="font-family: 'LINE Seed JP'"
	>
		<div class="absolute -top-40 -left-40 h-[640px] w-[640px] rounded-full bg-hero-gradient-1 blur-[120px]" />
		<div class="absolute -right-40 -bottom-60 h-[720px] w-[720px] rounded-full bg-hero-gradient-3 blur-[120px]" />
		<div class="relative flex items-center gap-5 text-3xl font-bold">
			<span>{{ site.name }}</span>
			<span v-if="section" class="rounded-full bg-glass-bg px-2.5 py-0.5 text-sm text-brand-1">{{ section }}</span>
		</div>
		<div class="relative flex flex-col gap-6">
			<h1 class="text-7xl leading-tight font-bold">{{ title }}</h1>
			<p v-if="description" class="text-3xl leading-normal text-text-2">{{ description }}</p>
		</div>
		<p class="relative text-2xl text-text-2">{{ site.url }}</p>
	</div>
</template>
