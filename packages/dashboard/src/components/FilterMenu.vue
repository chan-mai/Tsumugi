<script setup lang="ts">
import { CirclePlus } from '@lucide/vue';
import { Popover, PopoverButton, PopoverPanel, TransitionRoot } from '@headlessui/vue';
import { useI18n } from 'vue-i18n';
import { CHIP_DASHED, CHIP_VALUE, MENU_CAPTION, MENU_ITEM, MENU_ITEM_HOVER, MENU_PANEL } from '../ui';
import CheckBox from './CheckBox.vue';
import LoadingState from './LoadingState.vue';

const props = defineProps<{
	title: string;
	options: string[];
	selected: string;
	labelOf?: (option: string) => string;
	loading?: boolean;
}>();
const emit = defineEmits<{ select: [value: string] }>();
const { t } = useI18n();

const label = (option: string) => props.labelOf?.(option) ?? option;
</script>

<template>
	<Popover v-slot="{ open }" class="relative">
		<PopoverButton :class="CHIP_DASHED">
			<CirclePlus class="size-4 text-ink-muted" aria-hidden="true" />
			{{ title }}
			<span v-if="selected" :class="CHIP_VALUE">{{ label(selected) }}</span>
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
			<PopoverPanel static v-slot="{ close }" :class="MENU_PANEL" class="max-h-72 w-56 max-w-[calc(100vw-2rem)] overflow-auto">
				<button
					v-for="option in options"
					:key="option"
					type="button"
					:class="[MENU_ITEM, MENU_ITEM_HOVER]"
					@click="
						emit('select', selected === option ? '' : option);
						close();
					"
				>
					<CheckBox :checked="selected === option" />
					{{ label(option) }}
				</button>
				<LoadingState v-if="loading" />
				<p v-else-if="options.length === 0" :class="MENU_CAPTION">{{ t('toolbar.noOptions') }}</p>
			</PopoverPanel>
		</TransitionRoot>
	</Popover>
</template>
