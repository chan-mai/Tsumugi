<script setup lang="ts">
import { Check, ChevronDown, X } from '@lucide/vue';
import { Popover, PopoverButton, PopoverPanel, TransitionRoot } from '@headlessui/vue';
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { SEARCH_FIELDS as FIELDS, type SearchField } from '../search';
import { MENU_ITEM, MENU_ITEM_HOVER, MENU_PANEL } from '../ui';

const props = defineProps<{ field: SearchField; value: string }>();
const emit = defineEmits<{ 'update:field': [value: SearchField]; 'update:value': [value: string] }>();
const { t } = useI18n();

const draft = ref(props.value);
watch(
	() => props.value,
	(next) => {
		draft.value = next;
	},
);

function commit() {
	if (draft.value !== props.value) emit('update:value', draft.value);
}

function clear() {
	draft.value = '';
	emit('update:value', '');
}
</script>

<template>
	<div class="flex h-9 items-center rounded-lg border border-line-strong bg-surface focus-within:border-accent-strong">
		<Popover v-slot="{ open }" class="relative">
			<PopoverButton
				class="flex h-9 items-center gap-1.5 rounded-l-lg border-none bg-transparent px-3 text-sm text-ink-muted hover:bg-canvas"
			>
				{{ t(`search.${props.field}`) }}
				<ChevronDown class="size-3.5" aria-hidden="true" />
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
				<PopoverPanel static v-slot="{ close }" :class="MENU_PANEL" class="w-48 max-w-[calc(100vw-2rem)]">
					<button
						v-for="field in FIELDS"
						:key="field"
						type="button"
						:class="[MENU_ITEM, MENU_ITEM_HOVER]"
						@click="
							emit('update:field', field);
							close();
						"
					>
						<span class="flex size-4 shrink-0 items-center justify-center">
							<Check v-if="props.field === field" class="size-3.5" aria-hidden="true" />
						</span>
						{{ t(`search.${field}`) }}
					</button>
				</PopoverPanel>
			</TransitionRoot>
		</Popover>

		<input
			v-model="draft"
			type="search"
			:placeholder="t('search.placeholder', { field: t(`search.${props.field}`) })"
			class="h-9 w-44 border-none bg-transparent px-2 text-sm outline-none placeholder:text-ink-subtle sm:w-56"
			@change="commit"
			@keyup.enter="commit"
		/>

		<button
			v-if="props.value"
			type="button"
			class="flex h-9 items-center rounded-r-lg border-none bg-transparent px-2 text-ink-muted hover:bg-canvas"
			:aria-label="t('search.clear')"
			@click="clear"
		>
			<X class="size-3.5" aria-hidden="true" />
		</button>
	</div>
</template>
