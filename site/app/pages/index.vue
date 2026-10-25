<script setup lang="ts">
useSeoMeta({ title: 'Tsumugi Docs', description: 'Cloudflare Workers向けに設計されたジョブマネジメントシステム' });
</script>

<template>
	<div class="relative overflow-hidden">
		<HomeHero />
		<div class="relative">
			<div class="pointer-events-none absolute inset-0 -z-10" aria-hidden="true">
				<div class="absolute -left-40 top-40 size-[36rem] rounded-full bg-hero-gradient-1 opacity-40 blur-[120px]" />
				<div class="absolute -right-40 top-[60rem] size-[40rem] rounded-full bg-hero-gradient-3 opacity-40 blur-[120px]" />
				<div class="absolute -left-20 bottom-40 size-[32rem] rounded-full bg-hero-gradient-2 opacity-40 blur-[120px]" />
			</div>
			<HomeProblems />
			<HomeCode />
			<HomeFeatures />
			<HomeShowcase />
			<HomeStart />
		</div>
	</div>
</template>
