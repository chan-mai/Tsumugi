<script setup lang="ts">
import { Popover, PopoverButton, PopoverPanel, TransitionRoot } from '@headlessui/vue';
import { computed } from 'vue';

/** 作成日時の範囲, epochミリ秒でnullは未指定 */
const props = defineProps<{ from: number | null; to: number | null }>();
const emit = defineEmits<{ 'update:from': [value: number | null]; 'update:to': [value: number | null] }>();

/** `input[type=date]`が読む`YYYY-MM-DD`, ローカル時刻で組み立てる */
function toDateInput(value: number | null): string {
	if (value === null) return '';
	const at = new Date(value);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** 下限はその日の0時, 上限はその日の終わりにする, 同じ日を選んだときに0件にならないようにする */
function fromDateInput(text: string, edge: 'start' | 'end'): number | null {
	if (!text) return null;
	const [year, month, day] = text.split('-').map(Number);
	if (year === undefined || month === undefined || day === undefined) return null;
	return edge === 'start' ? new Date(year, month - 1, day).getTime() : new Date(year, month - 1, day, 23, 59, 59, 999).getTime();
}

const label = computed(() => {
	if (props.from === null && props.to === null) return '';
	return `${toDateInput(props.from) || '…'} - ${toDateInput(props.to) || '…'}`;
});
</script>

<template>
	<Popover v-slot="{ open }" class="relative">
		<PopoverButton
			class="flex h-8 items-center gap-1.5 rounded-card border border-dashed border-border bg-background px-3 text-sm hover:bg-accent"
		>
			<svg viewBox="0 0 16 16" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
				<rect x="2.2" y="3.2" width="11.6" height="10.6" rx="1.4" />
				<path d="M2.2 6.4h11.6M5.5 2v2.4M10.5 2v2.4" stroke-linecap="round" />
			</svg>
			Created
			<span v-if="label" class="ml-1 rounded bg-accent px-1.5 text-xs whitespace-nowrap">{{ label }}</span>
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
				class="absolute z-20 mt-1 w-64 max-w-[calc(100vw-2rem)] rounded-card border border-border bg-background p-3 shadow-md"
			>
				<label class="block text-xs text-muted-foreground" for="created-from">From</label>
				<input
					id="created-from"
					type="date"
					:value="toDateInput(props.from)"
					class="mt-1 h-8 w-full rounded-card border border-border bg-background px-2 text-sm"
					@change="emit('update:from', fromDateInput(($event.target as HTMLInputElement).value, 'start'))"
				/>

				<label class="mt-3 block text-xs text-muted-foreground" for="created-to">To</label>
				<input
					id="created-to"
					type="date"
					:value="toDateInput(props.to)"
					class="mt-1 h-8 w-full rounded-card border border-border bg-background px-2 text-sm"
					@change="emit('update:to', fromDateInput(($event.target as HTMLInputElement).value, 'end'))"
				/>

				<div class="mt-3 flex justify-end">
					<button
						type="button"
						class="h-8 rounded-card border-none bg-accent px-3 text-sm text-muted-foreground hover:bg-border"
						@click="
							emit('update:from', null);
							emit('update:to', null);
						"
					>
						Clear
					</button>
				</div>
			</PopoverPanel>
		</TransitionRoot>
	</Popover>
</template>
