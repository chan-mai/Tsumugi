<script setup lang="ts">
import ModalShell from './ModalShell.vue';
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { startRun } from '../api';
import { button, ERROR_TEXT, INPUT as FIELD, LABEL } from '../ui';

const props = defineProps<{ open: boolean; flows: string[] }>();
const emit = defineEmits<{ close: []; created: [id: string] }>();
const { t } = useI18n();

const flow = ref('');
const input = ref('{}');
const id = ref('');
const error = ref<string | null>(null);
const busy = ref(false);

watch(
	() => props.open,
	(open) => {
		if (!open) return;
		flow.value = props.flows[0] ?? '';
		input.value = '{}';
		id.value = '';
		error.value = null;
	},
);

async function submit() {
	error.value = null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(input.value);
	} catch {
		error.value = t('newRun.invalidInput');
		return;
	}

	busy.value = true;
	try {
		const created = await startRun({ flow: flow.value, input: parsed, ...(id.value ? { id: id.value } : {}) });
		emit('created', created.id);
		emit('close');
	} catch (e) {
		error.value = e instanceof Error ? e.message : String(e);
	} finally {
		busy.value = false;
	}
}

const TEXTAREA =
	'block w-full rounded-lg border border-line-strong bg-surface p-3 font-mono text-xs text-ink outline-none focus:border-accent-strong';
</script>

<template>
	<ModalShell :open="open" :title="t('newRun.title')" width="lg" @close="emit('close')">
		<form class="space-y-4" @submit.prevent="submit">
			<div>
				<label :class="LABEL" for="new-run-flow">{{ t('common.flow') }}</label>
				<select id="new-run-flow" v-model="flow" :class="FIELD">
					<option v-for="name in flows" :key="name" :value="name">{{ name }}</option>
				</select>
			</div>

			<div>
				<label :class="LABEL" for="new-run-input">{{ t('newRun.input') }}</label>
				<textarea id="new-run-input" v-model="input" rows="6" spellcheck="false" :class="TEXTAREA" />
			</div>

			<div>
				<label :class="LABEL" for="new-run-id">{{ t('common.id') }}</label>
				<input id="new-run-id" v-model="id" type="text" :class="FIELD" />
			</div>

			<p v-if="error" :class="ERROR_TEXT">{{ error }}</p>

			<div class="flex justify-end gap-2">
				<button type="button" :class="button('secondary')" @click="emit('close')">{{ t('common.cancel') }}</button>
				<button type="submit" :class="button('primary')" :disabled="busy || !flow">
					{{ t('newRun.start') }}
				</button>
			</div>
		</form>
	</ModalShell>
</template>
