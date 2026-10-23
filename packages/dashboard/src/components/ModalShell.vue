<script setup lang="ts">
import { X } from '@lucide/vue';
import { Dialog, DialogPanel, DialogTitle, TransitionChild, TransitionRoot } from '@headlessui/vue';
import { useI18n } from 'vue-i18n';

const props = defineProps<{ open: boolean; title: string; width: 'md' | 'lg' }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();

const WIDTH = { md: 'max-w-md', lg: 'max-w-lg' } as const;
</script>

<template>
	<TransitionRoot :show="props.open" as="template">
		<Dialog class="relative z-40" @close="emit('close')">
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

			<div class="fixed inset-0 flex items-center justify-center p-4">
				<TransitionChild
					as="template"
					enter="duration-200 ease-out"
					enter-from="opacity-0 scale-95"
					enter-to="opacity-100 scale-100"
					leave="duration-150 ease-in"
					leave-from="opacity-100 scale-100"
					leave-to="opacity-0 scale-95"
				>
					<DialogPanel
						class="relative max-h-[85vh] w-full overflow-auto rounded-2xl border border-line bg-surface p-6"
						:class="WIDTH[props.width]"
					>
						<button
							type="button"
							:aria-label="t('common.close')"
							class="absolute top-5 right-5 flex size-8 items-center justify-center rounded-lg border-none bg-transparent text-ink-muted hover:bg-neutral-soft"
							@click="emit('close')"
						>
							<X class="size-4" aria-hidden="true" />
						</button>

						<DialogTitle class="mb-4 text-lg font-bold">{{ props.title }}</DialogTitle>

						<slot />
					</DialogPanel>
				</TransitionChild>
			</div>
		</Dialog>
	</TransitionRoot>
</template>
