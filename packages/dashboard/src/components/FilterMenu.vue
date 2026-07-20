<script setup lang="ts">
import { Popover, PopoverButton, PopoverPanel, TransitionRoot } from '@headlessui/vue';

defineProps<{ title: string; options: string[]; selected: string }>();
const emit = defineEmits<{ select: [value: string] }>();
</script>

<template>
	<Popover v-slot="{ open }" class="relative">
		<PopoverButton
			class="flex h-8 items-center gap-1.5 rounded-card border border-dashed border-border bg-background px-3 text-sm hover:bg-accent"
		>
			<svg viewBox="0 0 16 16" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
				<circle cx="8" cy="8" r="6.4" />
				<path d="M8 5.2v5.6M5.2 8h5.6" stroke-linecap="round" />
			</svg>
			{{ title }}
			<span v-if="selected" class="ml-1 rounded bg-accent px-1.5 text-xs">{{ selected }}</span>
		</PopoverButton>

		<TransitionRoot
			:show="open"
			enter="transition duration-150 ease-out"
			enter-from="opacity-0 -translate-y-1"
			enter-to="opacity-100 translate-y-0"
			leave="transition duration-100 ease-in"
			leave-from="opacity-100 translate-y-0"
			leave-to="opacity-0 -translate-y-1"
		>
			<PopoverPanel
				static
				v-slot="{ close }"
				class="absolute z-20 mt-1 max-h-72 w-56 max-w-[calc(100vw-2rem)] overflow-auto rounded-card border border-border bg-background p-1 shadow-md"
			>
				<button
					v-for="option in options"
					:key="option"
					type="button"
					class="flex w-full items-center gap-2 rounded-sm border-none px-2 py-1.5 text-left text-sm hover:bg-accent"
					@click="
						emit('select', selected === option ? '' : option);
						close();
					"
				>
					<span class="flex size-4 shrink-0 items-center justify-center rounded-sm border border-border">
						<svg
							v-if="selected === option"
							viewBox="0 0 16 16"
							class="size-3"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							<path d="M3.5 8.5l3 3 6-6" />
						</svg>
					</span>
					{{ option }}
				</button>
				<p v-if="options.length === 0" class="px-2 py-1.5 text-sm text-muted-foreground">No options</p>
			</PopoverPanel>
		</TransitionRoot>
	</Popover>
</template>
