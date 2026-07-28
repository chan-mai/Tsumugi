<script setup lang="ts">
import { Popover, PopoverButton, PopoverPanel, TransitionRoot } from '@headlessui/vue';
import { ref, watch } from 'vue';
import { SEARCH_FIELDS as FIELDS, type SearchField } from '../search';

const props = defineProps<{ field: SearchField; value: string }>();
const emit = defineEmits<{ 'update:field': [value: SearchField]; 'update:value': [value: string] }>();

// 入力の途中で毎回問い合わせない, 確定時にだけ親へ渡す
const draft = ref(props.value);
watch(
	() => props.value,
	(next) => {
		draft.value = next;
	},
);

const labelOf = (field: SearchField) => FIELDS.find((option) => option.key === field)?.label ?? field;

function commit() {
	if (draft.value !== props.value) emit('update:value', draft.value);
}

function clear() {
	draft.value = '';
	emit('update:value', '');
}
</script>

<template>
	<div class="flex h-8 items-center rounded-card border border-border bg-background">
		<Popover v-slot="{ open }" class="relative">
			<PopoverButton class="flex h-8 items-center gap-1.5 rounded-l-card border-none px-3 text-sm text-muted-foreground hover:bg-accent">
				{{ labelOf(props.field) }}
				<svg viewBox="0 0 16 16" class="size-3" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
					<path d="M4 6.5l4 4 4-4" stroke-linecap="round" stroke-linejoin="round" />
				</svg>
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
					class="absolute z-20 mt-1 w-48 max-w-[calc(100vw-2rem)] rounded-card border border-border bg-background p-1 shadow-md"
				>
					<button
						v-for="option in FIELDS"
						:key="option.key"
						type="button"
						class="flex w-full items-center gap-2 rounded-sm border-none px-2 py-1.5 text-left text-sm hover:bg-accent"
						@click="
							emit('update:field', option.key);
							close();
						"
					>
						<!-- 選択は排他なのでチェックボックスは置かず, 選択中の項目にだけ印を出す -->
						<span class="flex size-4 shrink-0 items-center justify-center">
							<svg
								v-if="props.field === option.key"
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

		<input
			v-model="draft"
			type="search"
			:placeholder="`Search by ${labelOf(props.field).toLowerCase()}`"
			class="h-8 w-44 border-none bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground sm:w-56"
			@change="commit"
			@keyup.enter="commit"
		/>

		<button
			v-if="props.value"
			type="button"
			class="flex h-8 items-center rounded-r-card border-none px-2 text-muted-foreground hover:bg-accent"
			aria-label="Clear search"
			@click="clear"
		>
			<svg viewBox="0 0 16 16" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
				<path d="M4 4l8 8M12 4l-8 8" />
			</svg>
		</button>
	</div>
</template>
