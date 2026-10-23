<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { accept, confirmRequest, dismiss, isRevealed } from '../composables/useConfirm';
import { button } from '../ui';
import ModalShell from './ModalShell.vue';

const { t } = useI18n();
</script>

<template>
	<ModalShell :open="isRevealed" :title="confirmRequest?.title ?? ''" width="md" @close="dismiss()">
		<p v-if="confirmRequest?.message" class="text-sm break-all text-ink-muted">{{ confirmRequest.message }}</p>
		<div class="mt-6 flex justify-end gap-2">
			<button type="button" :class="button('secondary')" @click="dismiss()">{{ t('common.back') }}</button>
			<button type="button" :class="button(confirmRequest?.danger ? 'danger' : 'primary')" @click="accept()">
				{{ confirmRequest?.confirmLabel }}
			</button>
		</div>
	</ModalShell>
</template>
