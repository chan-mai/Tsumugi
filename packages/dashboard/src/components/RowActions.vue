<script setup lang="ts">
import { Ellipsis } from '@lucide/vue';
import { Menu, MenuButton, MenuItem, MenuItems, TransitionRoot } from '@headlessui/vue';
import { computed, toRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { MENU_CAPTION, MENU_ITEM, MENU_PANEL } from '../ui';
import { useJobActions } from '../useJobActions';

const props = defineProps<{ jobId: string; state: string; retryable?: boolean }>();
const emit = defineEmits<{ changed: []; message: [text: string] }>();
const { t } = useI18n();

const source = computed(() => ({ state: props.state, retryable: props.retryable }));
const { busy, canRetry, canCancel, goneReason, act } = useJobActions(toRef(source));

async function run(kind: 'retry' | 'cancel') {
	const message = await act(kind, props.jobId);
	if (message === null) return;
	emit('message', message);
	emit('changed');
}
</script>

<template>
	<Menu v-slot="{ open }" as="div" class="relative">
		<MenuButton
			class="flex size-8 items-center justify-center rounded-lg border-none bg-transparent text-ink-muted hover:bg-neutral-soft hover:text-ink"
			:aria-label="t('jobs.openMenu')"
		>
			<Ellipsis class="size-4" aria-hidden="true" />
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
			<MenuItems static :class="MENU_PANEL" class="right-0 w-48">
				<MenuItem v-slot="{ active }" :disabled="busy || !canRetry">
					<button
						type="button"
						:class="[
							MENU_ITEM,
							active && canRetry ? 'bg-accent-soft text-accent-strong' : '',
							canRetry ? '' : 'cursor-not-allowed text-ink-subtle',
						]"
						:title="goneReason"
						@click="canRetry && run('retry')"
					>
						{{ t('common.retry') }}
					</button>
				</MenuItem>
				<MenuItem v-slot="{ active }" :disabled="busy || !canCancel">
					<button
						type="button"
						:class="[
							MENU_ITEM,
							active && canCancel ? 'bg-critical-soft' : '',
							canCancel ? 'text-critical' : 'cursor-not-allowed text-ink-subtle',
						]"
						:title="t('jobs.cancelHint')"
						@click="canCancel && run('cancel')"
					>
						{{ t('common.cancel') }}
					</button>
				</MenuItem>
				<p v-if="!canRetry && !canCancel" :class="MENU_CAPTION">{{ t('jobs.noActions') }}</p>
			</MenuItems>
		</TransitionRoot>
	</Menu>
</template>
