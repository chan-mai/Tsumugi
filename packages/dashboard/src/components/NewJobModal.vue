<script setup lang="ts">
import ModalShell from './ModalShell.vue';
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { createJob } from '../api';
import { button, ERROR_TEXT, INPUT as FIELD, LABEL } from '../ui';

const props = defineProps<{ open: boolean; bindings: string[] }>();
const emit = defineEmits<{ close: []; created: [id: string] }>();
const { t } = useI18n();

const binding = ref('');
const payload = ref('{}');
const maxAttempts = ref<number | null>(null);
const delayMs = ref<number | null>(null);
const expiresInMs = ref<number | null>(null);
const priority = ref<number | null>(null);
const uniqueKey = ref('');
const concurrencyKey = ref('');
const partitionKey = ref('');
const error = ref<string | null>(null);
const busy = ref(false);

watch(
	() => props.open,
	(open) => {
		if (!open) return;
		binding.value = props.bindings[0] ?? '';
		payload.value = '{}';
		maxAttempts.value = null;
		delayMs.value = null;
		expiresInMs.value = null;
		priority.value = null;
		uniqueKey.value = '';
		concurrencyKey.value = '';
		partitionKey.value = '';
		error.value = null;
	},
);

async function submit() {
	error.value = null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(payload.value);
	} catch {
		error.value = t('newJob.invalidPayload');
		return;
	}

	busy.value = true;
	try {
		const { id } = await createJob({
			binding: binding.value,
			payload: parsed,
			...(maxAttempts.value !== null ? { maxAttempts: maxAttempts.value } : {}),
			...(delayMs.value !== null ? { delayMs: delayMs.value } : {}),
			...(expiresInMs.value !== null ? { expiresInMs: expiresInMs.value } : {}),
			...(priority.value !== null ? { priority: priority.value } : {}),
			...(uniqueKey.value ? { uniqueKey: uniqueKey.value } : {}),
			...(concurrencyKey.value ? { concurrencyKey: concurrencyKey.value } : {}),
			...(partitionKey.value ? { partitionKey: partitionKey.value } : {}),
		});
		emit('created', id);
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
	<ModalShell :open="open" :title="t('newJob.title')" width="lg" @close="emit('close')">
		<form class="space-y-4" @submit.prevent="submit">
			<div>
				<label :class="LABEL" for="new-job-binding">{{ t('common.binding') }}</label>
				<select id="new-job-binding" v-model="binding" :class="FIELD">
					<option v-for="name in bindings" :key="name" :value="name">{{ name }}</option>
				</select>
			</div>

			<div>
				<label :class="LABEL" for="new-job-payload">{{ t('newJob.payload') }}</label>
				<textarea id="new-job-payload" v-model="payload" rows="6" spellcheck="false" :class="TEXTAREA" />
			</div>

			<div class="grid gap-4 sm:grid-cols-2">
				<div>
					<label :class="LABEL" for="new-job-attempts">{{ t('newJob.maxAttempts') }}</label>
					<input id="new-job-attempts" v-model.number="maxAttempts" type="number" min="1" placeholder="3" :class="FIELD" />
				</div>
				<div>
					<label :class="LABEL" for="new-job-priority">{{ t('newJob.priority') }}</label>
					<input id="new-job-priority" v-model.number="priority" type="number" placeholder="0" :class="FIELD" />
				</div>
				<div>
					<label :class="LABEL" for="new-job-delay">{{ t('newJob.delay') }}</label>
					<input id="new-job-delay" v-model.number="delayMs" type="number" min="0" placeholder="0" :class="FIELD" />
				</div>
				<div>
					<label :class="LABEL" for="new-job-expires">{{ t('newJob.expiresIn') }}</label>
					<input id="new-job-expires" v-model.number="expiresInMs" type="number" min="1" :class="FIELD" />
				</div>
			</div>

			<div class="grid gap-4 sm:grid-cols-2">
				<div>
					<label :class="LABEL" for="new-job-unique">{{ t('newJob.uniqueKey') }}</label>
					<input id="new-job-unique" v-model="uniqueKey" type="text" :class="FIELD" />
				</div>
				<div>
					<label :class="LABEL" for="new-job-concurrency">{{ t('newJob.concurrencyKey') }}</label>
					<input id="new-job-concurrency" v-model="concurrencyKey" type="text" :class="FIELD" />
				</div>
				<div>
					<label :class="LABEL" for="new-job-partition">{{ t('newJob.partitionKey') }}</label>
					<input id="new-job-partition" v-model="partitionKey" type="text" :placeholder="t('newJob.requiredWhenSharded')" :class="FIELD" />
				</div>
			</div>

			<p v-if="error" :class="ERROR_TEXT">{{ error }}</p>

			<div class="flex justify-end gap-2">
				<button type="button" :class="button('secondary')" @click="emit('close')">{{ t('common.cancel') }}</button>
				<button type="submit" :class="button('primary')" :disabled="busy || !binding">
					{{ t('newJob.create') }}
				</button>
			</div>
		</form>
	</ModalShell>
</template>
