<script setup lang="ts">
import { Dialog, DialogPanel, DialogTitle, TransitionChild, TransitionRoot } from '@headlessui/vue';

const props = defineProps<{ open: boolean; title: string; width: 'lg' | '2xl' | '5xl' }>();
const emit = defineEmits<{ close: [] }>();

const WIDTH = { lg: 'max-w-lg', '2xl': 'max-w-2xl', '5xl': 'max-w-5xl' } as const;
</script>

<template>
	<TransitionRoot :show="props.open" as="template">
		<Dialog class="relative z-30" @close="emit('close')">
			<TransitionChild
				as="template"
				enter="duration-200 ease-out"
				enter-from="opacity-0"
				enter-to="opacity-100"
				leave="duration-150 ease-in"
				leave-from="opacity-100"
				leave-to="opacity-0"
			>
				<div class="fixed inset-0 bg-black/30" aria-hidden="true" />
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
						class="relative max-h-[85vh] w-full overflow-auto rounded-card border border-border bg-background p-4 shadow-lg sm:p-6"
						:class="WIDTH[props.width]"
					>
						<button
							type="button"
							aria-label="Close"
							class="absolute top-4 right-4 flex size-8 items-center justify-center rounded-card border-none text-muted-foreground hover:bg-accent"
							@click="emit('close')"
						>
							<svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
								<path d="M4 4l8 8M12 4l-8 8" />
							</svg>
						</button>

						<DialogTitle class="mb-4 text-lg font-bold">{{ props.title }}</DialogTitle>

						<slot />
					</DialogPanel>
				</TransitionChild>
			</div>
		</Dialog>
	</TransitionRoot>
</template>
