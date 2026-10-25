<script setup lang="ts">
const config = useRuntimeConfig();
const year = new Date().getFullYear();
const years = year > 2026 ? `2026-${year}` : String(year);
</script>

<template>
	<footer class="border-t border-divider py-8 text-center text-sm text-text-3">
		© {{ years }}
		<a :href="config.public.repo" target="_blank" rel="noopener" class="underline underline-offset-4 hover:text-brand-1">Tsumugi</a>
		by
		<a href="https://mq1.dev/about" target="_blank" rel="noopener" class="underline underline-offset-4 hover:text-brand-1">chan-mai</a>.
		Released under the MIT License.
	</footer>
</template>
