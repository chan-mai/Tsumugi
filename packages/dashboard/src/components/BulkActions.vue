<script setup lang="ts">
import { ListChecks } from '@lucide/vue';
import { Menu, MenuButton, MenuItem, MenuItems, TransitionRoot } from '@headlessui/vue';
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { bulkAction } from '../api';
import { confirmAction } from '../composables/useConfirm';
import { CHIP, MENU_ITEM, MENU_PANEL } from '../ui';

// サーバ側制限の事前提示用
const TARGET_STATES = { retry: ['FAILED', 'STALLED'], cancel: ['SCHEDULED', 'QUEUED', 'RUNNING'] } as const;

const props = defineProps<{ ids: string[] }>();
const emit = defineEmits<{ changed: []; message: [text: string] }>();
const { t } = useI18n();

const busy = ref(false);

async function run(action: 'retry' | 'cancel') {
	const ids = [...props.ids];
	const confirmed = await confirmAction({
		title: t(action === 'retry' ? 'bulk.retryTitle' : 'bulk.cancelTitle', { count: ids.length }),
		message: t('bulk.appliesTo', { states: states(action) }),
		confirmLabel: t(action === 'retry' ? 'common.retry' : 'common.cancel'),
		danger: action === 'cancel',
	});
	if (!confirmed) return;
	busy.value = true;
	try {
		const result = await bulkAction(action, { ids });
		const parts = [t('bulk.accepted', { count: result.ok.length })];
		if (result.failed.length > 0) parts.push(t('bulk.refused', { count: result.failed.length }));
		emit('message', parts.join(', '));
		emit('changed');
	} catch (error) {
		emit('message', error instanceof Error ? error.message : t('jobs.requestFailed'));
	} finally {
		busy.value = false;
	}
}

const states = (action: 'retry' | 'cancel') => TARGET_STATES[action].map((state) => t(`state.${state}`)).join(t('bulk.and'));
</script>

<template>
	<Menu v-slot="{ open }" as="div" class="relative">
		<MenuButton :disabled="busy" :class="CHIP">
			<ListChecks class="size-4 text-ink-muted" aria-hidden="true" />
			{{ t('bulk.selected', { count: props.ids.length }) }}
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
			<MenuItems static :class="MENU_PANEL" class="right-0 w-56">
				<MenuItem v-slot="{ active }">
					<button type="button" :class="[MENU_ITEM, active ? 'bg-accent-soft text-accent-strong' : '']" @click="run('retry')">
						{{ t('bulk.retrySelected') }}
					</button>
				</MenuItem>
				<MenuItem v-slot="{ active }">
					<button type="button" :class="[MENU_ITEM, 'text-critical', active ? 'bg-critical-soft' : '']" @click="run('cancel')">
						{{ t('bulk.cancelSelected') }}
					</button>
				</MenuItem>
			</MenuItems>
		</TransitionRoot>
	</Menu>
</template>
