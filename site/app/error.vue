<script setup lang="ts">
import type { NuxtError } from '#app';

const props = defineProps<{ error: NuxtError }>();
const { t } = useI18n();
const localePath = useLocalePath();
useLocaleHtmlAttrs();
usePageTitle(() => t(props.error.statusCode === 404 ? 'error.notFound' : 'error.title'));
</script>

<template>
	<NuxtLayout>
		<section class="mx-auto max-w-xl px-6 py-32 text-center">
			<p class="text-7xl font-extrabold text-brand-3">{{ error.statusCode }}</p>
			<h1 class="mt-4 text-xl font-bold">{{ $t(error.statusCode === 404 ? 'error.notFound' : 'error.heading') }}</h1>
			<NuxtLink
				:to="localePath('/')"
				class="mt-8 inline-block rounded-full bg-button-brand-bg px-6 py-2.5 text-sm font-semibold text-button-brand-text hover:bg-button-brand-hover-bg"
				>{{ $t('error.back') }}</NuxtLink
			>
		</section>
	</NuxtLayout>
</template>
