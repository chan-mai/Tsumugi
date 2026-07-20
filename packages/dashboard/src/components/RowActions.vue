<script setup lang="ts">
import { Menu, MenuButton, MenuItem, MenuItems, TransitionRoot } from '@headlessui/vue';
import { ref } from 'vue';
import { cancelJob, retryJob } from '../api';

const props = defineProps<{ jobId: string; state: string }>();
const emit = defineEmits<{ changed: []; message: [text: string] }>();

const busy = ref(false);

async function act(kind: 'retry' | 'cancel') {
	busy.value = true;
	try {
		const result = await (kind === 'retry' ? retryJob(props.jobId) : cancelJob(props.jobId));
		// 409は状態が合わず操作できなかった場合, 成功したと見せかけない
		emit('message', result.ok ? 'Accepted' : 'Not allowed in the current state');
		emit('changed');
	} catch {
		emit('message', 'Request failed');
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<Menu v-slot="{ open }" as="div" class="relative">
		<MenuButton
			class="flex size-8 items-center justify-center rounded-card border-none text-muted-foreground hover:bg-accent"
			aria-label="Open menu"
		>
			<svg viewBox="0 0 16 16" class="size-4" fill="currentColor" aria-hidden="true">
				<circle cx="3" cy="8" r="1.3" />
				<circle cx="8" cy="8" r="1.3" />
				<circle cx="13" cy="8" r="1.3" />
			</svg>
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
				class="absolute right-0 z-20 mt-1 w-40 rounded-card border border-border bg-background p-1 text-sm shadow-md focus:outline-none"
			>
				<MenuItem v-slot="{ active }" :disabled="busy">
					<button
						type="button"
						class="w-full rounded-sm border-none px-2 py-1.5 text-left"
						:class="active ? 'bg-accent' : ''"
						@click="act('retry')"
					>
						Retry
					</button>
				</MenuItem>
				<MenuItem v-slot="{ active }" :disabled="busy">
					<button
						type="button"
						class="w-full rounded-sm border-none px-2 py-1.5 text-left text-destructive"
						:class="active ? 'bg-accent' : ''"
						@click="act('cancel')"
					>
						Cancel
					</button>
				</MenuItem>
			</MenuItems>
		</TransitionRoot>
	</Menu>
</template>
