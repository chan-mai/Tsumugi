<script setup lang="ts">
import { Menu, MenuButton, MenuItem, MenuItems, TransitionRoot } from '@headlessui/vue';
import { computed, ref } from 'vue';
import { cancelJob, retryJob } from '../api';

const props = defineProps<{ jobId: string; state: string; retryable?: boolean }>();
const emit = defineEmits<{ changed: []; message: [text: string] }>();

const busy = ref(false);
/** 410を受けたら以後は押させない, 一覧はD1から引くので再読込しても行は消えない */
const gone = ref(false);

const canRetry = computed(() => !gone.value && props.retryable !== false);
const canCancel = computed(() => !gone.value && props.state === 'SCHEDULED');

/** retryableはサーバの近似,実際に消えているかは押して410が返って初めて分かる */
const retryTitle = computed(() =>
	gone.value || props.retryable === false ? 'Removed from the coordinator after the retention period' : undefined,
);

async function act(kind: 'retry' | 'cancel') {
	busy.value = true;
	try {
		const result = await (kind === 'retry' ? retryJob(props.jobId) : cancelJob(props.jobId));
		if (result.gone) gone.value = true;
		emit('message', result.message);
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
				class="absolute right-0 z-20 mt-1 w-52 rounded-card border border-border bg-background p-1 text-sm shadow-md focus:outline-none"
			>
				<MenuItem v-slot="{ active }" :disabled="busy || !canRetry">
					<button
						type="button"
						class="w-full rounded-sm border-none px-2 py-1.5 text-left"
						:class="[active && canRetry ? 'bg-accent' : '', canRetry ? '' : 'cursor-not-allowed text-muted-foreground']"
						:title="retryTitle"
						@click="canRetry && act('retry')"
					>
						Retry
					</button>
				</MenuItem>
				<MenuItem v-slot="{ active }" :disabled="busy || !canCancel">
					<button
						type="button"
						class="w-full rounded-sm border-none px-2 py-1.5 text-left"
						:class="[active && canCancel ? 'bg-accent' : '', canCancel ? 'text-destructive' : 'cursor-not-allowed text-muted-foreground']"
						title="Only scheduled jobs can be cancelled"
						@click="canCancel && act('cancel')"
					>
						Cancel
					</button>
				</MenuItem>
				<p v-if="!canRetry && !canCancel" class="px-2 py-1.5 text-xs text-muted-foreground">No actions available</p>
			</MenuItems>
		</TransitionRoot>
	</Menu>
</template>
