<script setup lang="ts">
import type { NuxtError } from '#app';

const props = defineProps<{ error: NuxtError }>();
usePageTitle(props.error.statusCode === 404 ? 'ページが見つかりません' : 'エラー');
</script>

<template>
	<NuxtLayout>
		<section class="mx-auto max-w-xl px-6 py-32 text-center">
			<p class="text-7xl font-extrabold text-brand-3">{{ error.statusCode }}</p>
			<h1 class="mt-4 text-xl font-bold">{{ error.statusCode === 404 ? 'ページが見つかりません' : 'エラーが発生しました' }}</h1>
			<NuxtLink
				to="/"
				class="mt-8 inline-block rounded-full bg-button-brand-bg px-6 py-2.5 text-sm font-semibold text-button-brand-text hover:bg-button-brand-hover-bg"
				>トップへ戻る</NuxtLink
			>
		</section>
	</NuxtLayout>
</template>
