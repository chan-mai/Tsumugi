<script setup lang="ts">
import { Calendar } from '@lucide/vue';
import { Popover, PopoverButton, PopoverPanel, TransitionRoot } from '@headlessui/vue';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { fromDateInput, toDateInput } from '../dates';
import { button, CHIP_DASHED, CHIP_VALUE, INPUT, MENU_PANEL } from '../ui';

const props = defineProps<{ from: number | null; to: number | null }>();
const emit = defineEmits<{ 'update:from': [value: number | null]; 'update:to': [value: number | null] }>();
const { t } = useI18n();

const label = computed(() => {
	if (props.from === null && props.to === null) return '';
	return `${toDateInput(props.from) || '…'} - ${toDateInput(props.to) || '…'}`;
});
</script>

<template>
	<Popover v-slot="{ open }" class="relative">
		<PopoverButton :class="CHIP_DASHED">
			<Calendar class="size-4 text-ink-muted" aria-hidden="true" />
			{{ t('toolbar.created') }}
			<span v-if="label" :class="CHIP_VALUE" class="whitespace-nowrap">{{ label }}</span>
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
			<PopoverPanel static :class="MENU_PANEL" class="w-64 max-w-[calc(100vw-2rem)] p-3">
				<label class="block text-xs text-ink-muted" for="created-from">{{ t('toolbar.from') }}</label>
				<input
					id="created-from"
					type="date"
					:value="toDateInput(props.from)"
					:class="INPUT"
					class="mt-1"
					@change="emit('update:from', fromDateInput(($event.target as HTMLInputElement).value, 'start'))"
				/>

				<label class="mt-3 block text-xs text-ink-muted" for="created-to">{{ t('toolbar.to') }}</label>
				<input
					id="created-to"
					type="date"
					:value="toDateInput(props.to)"
					:class="INPUT"
					class="mt-1"
					@change="emit('update:to', fromDateInput(($event.target as HTMLInputElement).value, 'end'))"
				/>

				<div class="mt-3 flex justify-end">
					<button
						type="button"
						:class="button('ghost', 'sm')"
						@click="
							emit('update:from', null);
							emit('update:to', null);
						"
					>
						{{ t('toolbar.clear') }}
					</button>
				</div>
			</PopoverPanel>
		</TransitionRoot>
	</Popover>
</template>
