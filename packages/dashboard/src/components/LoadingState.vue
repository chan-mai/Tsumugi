<script setup lang="ts">
import { LoaderCircle } from '@lucide/vue';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
</script>

<template>
	<div class="flex items-center justify-center gap-2 py-10 text-sm text-ink-subtle" role="status">
		<LoaderCircle class="size-4 animate-spin" aria-hidden="true" />
		{{ t('common.loading') }}
	</div>
</template>
