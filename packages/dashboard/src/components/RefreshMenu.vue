<script setup lang="ts">
import { Check } from '@lucide/vue';
import { Popover, PopoverButton, PopoverPanel, TransitionRoot } from '@headlessui/vue';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { REFRESH_OPTIONS } from '../refresh';
import { CHIP, MENU_ITEM, MENU_ITEM_HOVER, MENU_PANEL } from '../ui';

const props = defineProps<{ interval: number }>();
const emit = defineEmits<{ 'update:interval': [value: number] }>();
const { t } = useI18n();

const labelOf = (ms: number) =>
	ms === 0 ? t('toolbar.off') : (REFRESH_OPTIONS.find((option) => option.ms === ms)?.label ?? t('toolbar.off'));
const label = computed(() => labelOf(props.interval));
</script>

<template>
	<Popover v-slot="{ open }" class="relative">
		<PopoverButton :class="CHIP" :aria-label="`${t('toolbar.refreshInterval')}: ${label}`">
			<span class="size-2 rounded-full" :class="props.interval > 0 ? 'animate-pulse bg-positive' : 'bg-line-strong'" aria-hidden="true" />
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
			<PopoverPanel static v-slot="{ close }" :class="MENU_PANEL" class="right-0 w-36">
				<button
					v-for="option in REFRESH_OPTIONS"
					:key="option.ms"
					type="button"
					:class="[MENU_ITEM, MENU_ITEM_HOVER]"
					@click="
						emit('update:interval', option.ms);
						close();
					"
				>
					<span class="flex size-4 shrink-0 items-center justify-center">
						<Check v-if="props.interval === option.ms" class="size-3.5" aria-hidden="true" />
					</span>
					{{ labelOf(option.ms) }}
				</button>
			</PopoverPanel>
		</TransitionRoot>
	</Popover>
</template>
