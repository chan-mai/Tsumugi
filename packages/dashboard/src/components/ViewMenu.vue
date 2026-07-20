<script setup lang="ts">
import { Popover, PopoverButton, PopoverPanel, TransitionRoot } from '@headlessui/vue';

defineProps<{ options: { key: string; label: string }[]; visible: Record<string, boolean> }>();
const emit = defineEmits<{ toggle: [key: string] }>();
</script>

<template>
	<Popover v-slot="{ open }" class="relative">
		<PopoverButton class="flex h-8 items-center gap-1.5 rounded-card border border-border bg-background px-3 text-sm hover:bg-accent">
			<svg
				viewBox="0 0 16 16"
				class="size-3.5"
				fill="none"
				stroke="currentColor"
				stroke-width="1.3"
				stroke-linecap="round"
				aria-hidden="true"
			>
				<path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
			</svg>
			View
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
				class="absolute right-0 z-20 mt-1 w-56 max-w-[calc(100vw-2rem)] rounded-card border border-border bg-background p-1 shadow-md"
			>
				<p class="px-2 py-1.5 text-xs text-muted-foreground">Toggle columns</p>
				<button
					v-for="option in options"
					:key="option.key"
					type="button"
					class="flex w-full items-center gap-2 rounded-sm border-none px-2 py-1.5 text-left text-sm hover:bg-accent"
					@click="emit('toggle', option.key)"
				>
					<span class="flex size-4 shrink-0 items-center justify-center rounded-sm border border-border">
						<svg
							v-if="visible[option.key]"
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
					{{ option.label }}
				</button>
			</PopoverPanel>
		</TransitionRoot>
	</Popover>
</template>
