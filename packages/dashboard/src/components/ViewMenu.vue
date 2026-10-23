<script setup lang="ts">
import { Columns3 } from '@lucide/vue';
import { Popover, PopoverButton, PopoverPanel, TransitionRoot } from '@headlessui/vue';
import { useI18n } from 'vue-i18n';
import { CHIP, MENU_ITEM, MENU_ITEM_HOVER, MENU_PANEL } from '../ui';
import CheckBox from './CheckBox.vue';

defineProps<{ options: string[]; visible: Record<string, boolean> }>();
const emit = defineEmits<{ toggle: [key: string] }>();
const { t } = useI18n();
</script>

<template>
	<Popover v-slot="{ open }" class="relative">
		<PopoverButton :class="CHIP">
			<Columns3 class="size-4 text-ink-muted" aria-hidden="true" />
			{{ t('toolbar.view') }}
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
			<PopoverPanel static :class="MENU_PANEL" class="right-0 w-56 max-w-[calc(100vw-2rem)]">
				<button v-for="key in options" :key="key" type="button" :class="[MENU_ITEM, MENU_ITEM_HOVER]" @click="emit('toggle', key)">
					<CheckBox :checked="visible[key] === true" />
					{{ t(`columns.${key}`) }}
				</button>
			</PopoverPanel>
		</TransitionRoot>
	</Popover>
</template>
