<script setup lang="ts">
import { Dialog, DialogPanel, DialogTitle, TransitionChild, TransitionRoot } from '@headlessui/vue';
import { ref, watch } from 'vue';
import { createJob } from '../api';

const props = defineProps<{ open: boolean; bindings: string[] }>();
const emit = defineEmits<{ close: []; created: [id: string] }>();

const binding = ref('');
const payload = ref('{}');
const maxAttempts = ref<number | null>(null);
const delayMs = ref<number | null>(null);
const priority = ref<number | null>(null);
const uniqueKey = ref('');
const concurrencyKey = ref('');
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
		priority.value = null;
		uniqueKey.value = '';
		concurrencyKey.value = '';
		error.value = null;
	},
);

async function submit() {
	error.value = null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(payload.value);
	} catch {
		// 送る前に弾く, サーバ往復を待たせない
		error.value = 'Payload must be valid JSON';
		return;
	}

	busy.value = true;
	try {
		const { id } = await createJob({
			binding: binding.value,
			payload: parsed,
			...(maxAttempts.value !== null ? { maxAttempts: maxAttempts.value } : {}),
			...(delayMs.value !== null ? { delayMs: delayMs.value } : {}),
			...(priority.value !== null ? { priority: priority.value } : {}),
			...(uniqueKey.value ? { uniqueKey: uniqueKey.value } : {}),
			...(concurrencyKey.value ? { concurrencyKey: concurrencyKey.value } : {}),
		});
		emit('created', id);
		emit('close');
	} catch (e) {
		error.value = e instanceof Error ? e.message : String(e);
	} finally {
		busy.value = false;
	}
}

const FIELD = 'h-9 w-full rounded-card border border-border bg-background px-3 text-sm';
const LABEL = 'mb-1 block text-sm text-muted-foreground';
</script>

<template>
	<TransitionRoot :show="open" as="template">
		<Dialog class="relative z-30" @close="emit('close')">
			<TransitionChild
				as="template"
				enter="duration-200 ease-out"
				enter-from="opacity-0"
				enter-to="opacity-100"
				leave="duration-150 ease-in"
				leave-from="opacity-100"
				leave-to="opacity-0"
			>
				<div class="fixed inset-0 bg-black/30" aria-hidden="true" />
			</TransitionChild>

			<div class="fixed inset-0 flex items-center justify-center p-4">
				<TransitionChild
					as="template"
					enter="duration-200 ease-out"
					enter-from="opacity-0 scale-95"
					enter-to="opacity-100 scale-100"
					leave="duration-150 ease-in"
					leave-from="opacity-100 scale-100"
					leave-to="opacity-0 scale-95"
				>
					<DialogPanel
						class="relative max-h-[85vh] w-full max-w-lg overflow-auto rounded-card border border-border bg-background p-4 shadow-lg sm:p-6"
					>
						<button
							type="button"
							aria-label="Close"
							class="absolute top-4 right-4 flex size-8 items-center justify-center rounded-card border-none text-muted-foreground hover:bg-accent"
							@click="emit('close')"
						>
							<svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
								<path d="M4 4l8 8M12 4l-8 8" />
							</svg>
						</button>

						<DialogTitle class="mb-4 text-lg font-bold">New job</DialogTitle>

						<form class="space-y-4" @submit.prevent="submit">
							<div>
								<label :class="LABEL" for="new-job-binding">Binding</label>
								<select id="new-job-binding" v-model="binding" :class="FIELD">
									<option v-for="name in bindings" :key="name" :value="name">{{ name }}</option>
								</select>
							</div>

							<div>
								<label :class="LABEL" for="new-job-payload">Payload (JSON)</label>
								<textarea
									id="new-job-payload"
									v-model="payload"
									rows="6"
									spellcheck="false"
									class="w-full rounded-card border border-border bg-background p-3 font-mono text-xs"
								/>
							</div>

							<div class="grid gap-4 sm:grid-cols-3">
								<div>
									<label :class="LABEL" for="new-job-attempts">Max attempts</label>
									<input id="new-job-attempts" v-model.number="maxAttempts" type="number" min="1" placeholder="3" :class="FIELD" />
								</div>
								<div>
									<label :class="LABEL" for="new-job-delay">Delay (ms)</label>
									<input id="new-job-delay" v-model.number="delayMs" type="number" min="0" placeholder="0" :class="FIELD" />
								</div>
								<div>
									<label :class="LABEL" for="new-job-priority">Priority</label>
									<input id="new-job-priority" v-model.number="priority" type="number" placeholder="0" :class="FIELD" />
								</div>
							</div>

							<div class="grid gap-4 sm:grid-cols-2">
								<div>
									<label :class="LABEL" for="new-job-unique">Unique key</label>
									<input id="new-job-unique" v-model="uniqueKey" type="text" placeholder="optional" :class="FIELD" />
								</div>
								<div>
									<label :class="LABEL" for="new-job-concurrency">Concurrency key</label>
									<input id="new-job-concurrency" v-model="concurrencyKey" type="text" placeholder="optional" :class="FIELD" />
								</div>
							</div>

							<p v-if="error" class="text-sm text-destructive">{{ error }}</p>

							<div class="flex justify-end gap-2">
								<button
									type="button"
									class="h-9 rounded-card border border-border bg-background px-4 text-sm hover:bg-accent"
									@click="emit('close')"
								>
									Cancel
								</button>
								<button
									type="submit"
									class="h-9 rounded-card border-none bg-primary px-4 text-sm text-primary-foreground disabled:opacity-50"
									:disabled="busy || !binding"
								>
									Create
								</button>
							</div>
						</form>
					</DialogPanel>
				</TransitionChild>
			</div>
		</Dialog>
	</TransitionRoot>
</template>
