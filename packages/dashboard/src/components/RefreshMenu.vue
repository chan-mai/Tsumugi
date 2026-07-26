<script setup lang="ts">
import { Popover, PopoverButton, PopoverPanel, TransitionRoot } from '@headlessui/vue';
import { computed } from 'vue';
import { REFRESH_OPTIONS } from '../refresh';

const props = defineProps<{ interval: number }>();
const emit = defineEmits<{ 'update:interval': [value: number] }>();

const label = computed(() => REFRESH_OPTIONS.find((option) => option.ms === props.interval)?.label ?? 'Off');
</script>

<template>
	<Popover v-slot="{ open }" class="relative">
		<PopoverButton class="flex h-8 items-center gap-2 rounded-card border border-border bg-background px-3 text-sm hover:bg-accent">
			<span class="size-2 rounded-full" :class="props.interval > 0 ? 'animate-pulse bg-green-500' : 'bg-gray-300'" aria-hidden="true" />
			{{ label }}
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
				class="absolute right-0 z-20 mt-1 w-44 rounded-card border border-border bg-background p-1 shadow-md"
			>
				<p class="px-2 py-1.5 text-xs text-muted-foreground">Refresh interval</p>
				<button
					v-for="option in REFRESH_OPTIONS"
					:key="option.ms"
					type="button"
					class="flex w-full items-center gap-2 rounded-sm border-none px-2 py-1.5 text-left text-sm hover:bg-accent"
					@click="
						emit('update:interval', option.ms);
						close();
					"
				>
					<!-- 選択は排他なので, 選択中の項目にだけ印を出す -->
					<span class="flex size-4 shrink-0 items-center justify-center">
						<svg
							v-if="props.interval === option.ms"
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
