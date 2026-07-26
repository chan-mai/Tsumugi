<script setup lang="ts">
import { Menu, MenuButton, MenuItem, MenuItems, TransitionRoot } from '@headlessui/vue';
import { ref } from 'vue';
import { bulkAction } from '../api';

/** 一括操作が受け付ける状態, サーバ側の制限を押す前に示す */
const TARGET_STATES = { retry: ['FAILED', 'STALLED'], cancel: ['SCHEDULED'] } as const;

const props = defineProps<{ ids: string[] }>();
const emit = defineEmits<{ changed: []; message: [text: string] }>();

const busy = ref(false);
const confirming = ref<'retry' | 'cancel' | null>(null);

async function run(action: 'retry' | 'cancel') {
	confirming.value = null;
	busy.value = true;
	try {
		const result = await bulkAction(action, { ids: props.ids });
		const parts = [`${result.ok.length} accepted`];
		if (result.failed.length > 0) parts.push(`${result.failed.length} refused`);
		emit('message', parts.join(', '));
		emit('changed');
	} catch (error) {
		emit('message', error instanceof Error ? error.message : 'Request failed');
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<Menu v-slot="{ open }" as="div" class="relative">
		<MenuButton
			:disabled="busy"
			class="flex h-8 items-center gap-1.5 rounded-card border border-border bg-background px-3 text-sm hover:bg-accent"
		>
			<svg viewBox="0 0 16 16" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
				<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h7" />
			</svg>
			{{ props.ids.length }} selected
		</MenuButton>

		<TransitionRoot
			:show="open"
			enter="transition duration-150 ease-out"
			enter-from="opacity-0 -translate-y-1"
			enter-to="opacity-100 translate-y-0"
			leave="transition duration-100 ease-in"
			leave-from="opacity-100 translate-y-0"
			leave-to="opacity-0 -translate-y-1"
		>
			<MenuItems
				static
				class="absolute right-0 z-20 mt-1 w-52 rounded-card border border-border bg-background p-1 text-sm shadow-md focus:outline-none"
			>
				<MenuItem v-slot="{ active }">
					<button
						type="button"
						class="w-full rounded-sm border-none px-2 py-1.5 text-left"
						:class="active ? 'bg-accent' : ''"
						@click="confirming = 'retry'"
					>
						Retry selected
					</button>
				</MenuItem>
				<MenuItem v-slot="{ active }">
					<button
						type="button"
						class="w-full rounded-sm border-none px-2 py-1.5 text-left text-destructive"
						:class="active ? 'bg-accent' : ''"
						@click="confirming = 'cancel'"
					>
						Cancel selected
					</button>
				</MenuItem>
			</MenuItems>
		</TransitionRoot>
	</Menu>

	<!-- 選択には対象外の状態も混ざり得るので, 受け付ける状態を押す前に示す -->
	<div v-if="confirming" class="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4" @click.self="confirming = null">
		<div class="w-full max-w-md rounded-card border border-border bg-background p-4 shadow-md">
			<h2 class="text-base font-medium">{{ confirming === 'retry' ? 'Retry' : 'Cancel' }} {{ props.ids.length }} jobs</h2>
			<p class="mt-2 text-sm text-muted-foreground">Applies to {{ TARGET_STATES[confirming].join(' and ') }} jobs.</p>
			<p class="mt-1 text-sm text-muted-foreground">Jobs in any other state are refused and reported.</p>
			<div class="mt-4 flex justify-end gap-2">
				<button
					type="button"
					class="h-8 rounded-card border-none bg-accent px-3 text-sm text-muted-foreground hover:bg-border"
					@click="confirming = null"
				>
					Cancel
				</button>
				<button type="button" class="h-8 rounded-card border-none bg-primary px-3 text-sm text-primary-foreground" @click="run(confirming)">
					Run
				</button>
			</div>
		</div>
	</div>
</template>
