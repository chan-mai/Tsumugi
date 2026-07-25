<script setup lang="ts">
import { Dialog, DialogPanel, DialogTitle, TransitionChild, TransitionRoot } from '@headlessui/vue';
import { ref, watch } from 'vue';
import { startRun } from '../api';

const props = defineProps<{ open: boolean; flows: string[] }>();
const emit = defineEmits<{ close: []; created: [id: string] }>();

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
		// 送る前に弾く,サーバ往復を待たせない
		error.value = 'Input must be valid JSON';
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

						<DialogTitle class="mb-4 text-lg font-bold">New run</DialogTitle>

						<form class="space-y-4" @submit.prevent="submit">
							<div>
								<label :class="LABEL" for="new-run-flow">Flow</label>
								<select id="new-run-flow" v-model="flow" :class="FIELD">
									<option v-for="name in flows" :key="name" :value="name">{{ name }}</option>
								</select>
							</div>

							<div>
								<label :class="LABEL" for="new-run-input">Input (JSON)</label>
								<textarea
									id="new-run-input"
									v-model="input"
									rows="6"
									spellcheck="false"
									class="w-full rounded-card border border-border bg-background p-3 font-mono text-xs"
								/>
							</div>

							<div>
								<label :class="LABEL" for="new-run-id">ID</label>
								<input id="new-run-id" v-model="id" type="text" placeholder="optional, reuse to avoid duplicates" :class="FIELD" />
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
									:disabled="busy || !flow"
								>
									Start
								</button>
							</div>
						</form>
					</DialogPanel>
				</TransitionChild>
			</div>
		</Dialog>
	</TransitionRoot>
</template>
