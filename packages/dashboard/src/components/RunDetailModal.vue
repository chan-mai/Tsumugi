<script setup lang="ts">
import { Dialog, DialogPanel, DialogTitle, TransitionChild, TransitionRoot } from '@headlessui/vue';
import { computed, ref, watch } from 'vue';
import RunGraph from './RunGraph.vue';
import StatusCell from './StatusCell.vue';
import { cancelRun, getRun, retryRun, type Run, type RunNode } from '../api';

const props = defineProps<{ runId: string | null }>();
const emit = defineEmits<{ close: []; changed: []; job: [jobId: string] }>();

const run = ref<Run | null>(null);
const nodes = ref<RunNode[]>([]);
const error = ref<string | null>(null);
const message = ref<string | null>(null);
const busy = ref(false);

const canRetry = computed(() => run.value?.state === 'FAILED');
const canCancel = computed(() => run.value?.state === 'RUNNING');

async function load(id: string) {
	try {
		const loaded = await getRun(id);
		run.value = loaded.run;
		nodes.value = loaded.nodes;
	} catch (e) {
		error.value = e instanceof Error ? e.message : String(e);
	}
}

watch(
	() => props.runId,
	async (id) => {
		if (!id) return;
		// 閉じるアニメーションの間に中身が消えないよう,開く時だけ差し替える
		run.value = null;
		nodes.value = [];
		error.value = null;
		message.value = null;
		await load(id);
	},
);

async function act(kind: 'retry' | 'cancel') {
	if (!props.runId) return;
	busy.value = true;
	try {
		const outcome = kind === 'retry' ? await retryRun(props.runId) : await cancelRun(props.runId);
		message.value = outcome.message;
		// 投影は数秒遅れるので即時には変わらないが,反映され次第この再読込で追いつく
		await load(props.runId);
		emit('changed');
	} finally {
		busy.value = false;
	}
}

const at = (value: number | null | undefined) => (value ? new Date(value).toLocaleString() : '-');

const pretty = (input: string | undefined) => {
	if (!input) return '';
	try {
		return JSON.stringify(JSON.parse(input), null, 2);
	} catch {
		return input;
	}
};
</script>

<template>
	<TransitionRoot :show="runId !== null" as="template">
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
						class="relative max-h-[85vh] w-full max-w-5xl overflow-auto rounded-card border border-border bg-background p-4 shadow-lg sm:p-6"
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

						<DialogTitle class="mb-4 text-lg font-bold">Run detail</DialogTitle>

						<p v-if="error" class="text-sm text-destructive">Failed to load: {{ error }}</p>
						<p v-else-if="!run" class="text-sm text-muted-foreground">Loading</p>
						<div v-else class="space-y-4 text-sm">
							<dl class="grid gap-y-2 sm:grid-cols-[10rem_1fr]">
								<dt class="text-muted-foreground">Status</dt>
								<dd><StatusCell :state="run.state" /></dd>
								<dt class="text-muted-foreground">ID</dt>
								<dd class="font-mono text-xs break-all">{{ run.id }}</dd>
								<dt class="text-muted-foreground">Flow</dt>
								<dd>{{ run.flow }}</dd>
								<dt class="text-muted-foreground">Nodes</dt>
								<dd class="tabular-nums">
									{{ run.node_done }} / {{ run.node_total }}
									<span v-if="run.node_failed > 0" class="text-destructive">({{ run.node_failed }} failed)</span>
								</dd>
								<dt class="text-muted-foreground">Created at</dt>
								<dd>{{ at(run.created_at) }}</dd>
								<dt class="text-muted-foreground">Updated at</dt>
								<dd>{{ at(run.updated_at) }}</dd>
							</dl>

							<div>
								<p class="mb-1 text-muted-foreground">Graph</p>
								<RunGraph :nodes="nodes" @select="emit('job', $event)" />
							</div>

							<div>
								<p class="mb-1 text-muted-foreground">Input</p>
								<pre class="overflow-auto rounded-card bg-muted p-3 text-xs">{{ pretty(run.input) }}</pre>
							</div>

							<div class="flex flex-wrap items-center gap-2 border-t border-border pt-4">
								<button
									type="button"
									class="h-8 rounded-card border border-border px-3 text-sm"
									:class="canRetry ? 'bg-background hover:bg-accent' : 'cursor-not-allowed text-muted-foreground'"
									:disabled="busy || !canRetry"
									title="Only failed runs can be resumed"
									@click="act('retry')"
								>
									Retry
								</button>
								<button
									type="button"
									class="h-8 rounded-card border border-border px-3 text-sm"
									:class="canCancel ? 'bg-background text-destructive hover:bg-accent' : 'cursor-not-allowed text-muted-foreground'"
									:disabled="busy || !canCancel"
									title="Running jobs are not stopped, only pending nodes"
									@click="act('cancel')"
								>
									Cancel
								</button>
								<span v-if="message" class="text-xs text-muted-foreground">{{ message }}</span>
							</div>
						</div>
					</DialogPanel>
				</TransitionChild>
			</div>
		</Dialog>
	</TransitionRoot>
</template>
