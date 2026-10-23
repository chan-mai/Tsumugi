<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';

const { t } = useI18n();
const route = useRoute();
</script>

<template>
	<div class="mb-6 flex flex-wrap items-center justify-between gap-4">
		<h1 class="text-2xl font-bold tracking-tight sm:text-3xl">{{ route.meta.title ? t(route.meta.title) : '' }}</h1>
		<div v-if="$slots.default" class="flex items-center gap-2">
			<slot />
		</div>
	</div>
</template>
