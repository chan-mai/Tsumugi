<script setup lang="ts">
defineProps<{ items: BreadcrumbItem[] }>();
</script>

<template>
	<nav aria-label="パンくずリスト">
		<ol class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-2">
			<li v-for="(item, index) in items" :key="index" class="flex items-center gap-2">
				<AppIcon v-if="index > 0" name="chevron-right" class="size-3.5 text-text-3" />
				<NuxtLink v-if="item.link" :to="item.link" class="underline underline-offset-4 hover:text-brand-1">{{ item.text }}</NuxtLink>
				<span v-else aria-current="page" class="font-semibold text-brand-1">{{ item.text }}</span>
			</li>
		</ol>
	</nav>
</template>
