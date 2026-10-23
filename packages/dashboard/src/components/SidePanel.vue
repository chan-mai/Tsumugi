<script setup lang="ts">
import { X } from '@lucide/vue';
import { Dialog, DialogPanel, DialogTitle, TransitionChild, TransitionRoot } from '@headlessui/vue';
import { useI18n } from 'vue-i18n';
import { isRevealed } from '../composables/useConfirm';

const props = defineProps<{ open: boolean; title: string }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();

// 確認モーダル内の操作を外側クリックとして扱わない
function requestClose() {
	if (!isRevealed.value) emit('close');
}
</script>

<template>
	<TransitionRoot :show="props.open" as="template">
		<Dialog class="relative z-30" @close="requestClose">
			<TransitionChild
				as="template"
				enter="duration-200 ease-out"
				enter-from="opacity-0"
				enter-to="opacity-100"
				leave="duration-150 ease-in"
				leave-from="opacity-100"
				leave-to="opacity-0"
			>
				<div class="fixed inset-0 bg-ink/40" aria-hidden="true" />
			</TransitionChild>

			<div class="fixed inset-y-0 right-0 flex w-full justify-end md:pl-16">
				<TransitionChild
					as="template"
					enter="duration-300 ease-out"
					enter-from="translate-x-full"
					enter-to="translate-x-0"
					leave="duration-200 ease-in"
					leave-from="translate-x-0"
					leave-to="translate-x-full"
				>
					<DialogPanel class="flex h-full w-full flex-col border-l border-line bg-surface md:w-[52rem] md:rounded-l-2xl">
						<div class="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-line px-6">
							<DialogTitle class="truncate text-lg font-bold">{{ props.title }}</DialogTitle>
							<button
								type="button"
								:aria-label="t('common.close')"
								class="flex size-8 shrink-0 items-center justify-center rounded-lg border-none bg-transparent text-ink-muted hover:bg-neutral-soft"
								@click="emit('close')"
							>
								<X class="size-4" aria-hidden="true" />
							</button>
						</div>
						<div class="min-h-0 flex-1 overflow-y-auto px-6 py-6">
							<slot />
						</div>
						<div v-if="$slots.footer" class="flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-6 py-4">
							<slot name="footer" />
						</div>
					</DialogPanel>
				</TransitionChild>
			</div>
		</Dialog>
	</TransitionRoot>
</template>
