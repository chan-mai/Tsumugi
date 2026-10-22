<script setup lang="ts">
import ModalShell from './ModalShell.vue';
import { computed, ref, watch } from 'vue';
import RunGraph from './RunGraph.vue';
import StatusCell from './StatusCell.vue';
import { cancelRun, getRun, retryRun, type Run, type RunNode } from '../api';
import { formatTimestamp } from '../time';

const props = defineProps<{ runId: string | null }>();
const emit = defineEmits<{ close: []; changed: []; job: [jobId: string]; run: [runId: string] }>();

const run = ref<Run | null>(null);
const nodes = ref<RunNode[]>([]);
const error = ref<string | null>(null);
const message = ref<string | null>(null);
const busy = ref(false);
// 親子run間の高速移動時の旧応答上書き防止用連番
let loadSequence = 0;

const canRetry = computed(() => run.value?.retryable === true);
const canCancel = computed(() => run.value?.state === 'RUNNING');

async function load(id: string) {
	const sequence = ++loadSequence;
	try {
		const loaded = await getRun(id);
		if (sequence !== loadSequence || props.runId !== id) return;
		run.value = loaded.run;
		nodes.value = loaded.nodes;
		error.value = null;
	} catch (e) {
		if (sequence !== loadSequence || props.runId !== id) return;
		error.value = e instanceof Error ? e.message : String(e);
	}
}

watch(
	() => props.runId,
	async (id) => {
		loadSequence++;
		if (!id) return;
		// 閉じるアニメーション中の内容消失防止、開く時のみ差し替え
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
		// 投影の数秒遅延で未反映の場合あり
		await load(props.runId);
		emit('changed');
	} catch (e) {
		message.value = e instanceof Error ? e.message : String(e);
	} finally {
		busy.value = false;
	}
}

const at = (value: number | null | undefined) => (value === null || value === undefined ? '-' : formatTimestamp(value));

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
	<ModalShell :open="runId !== null" title="Run detail" width="5xl" @close="emit('close')">
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
				<template v-if="run.parent_run_id">
					<dt class="text-muted-foreground">Parent run</dt>
					<dd>
						<button
							type="button"
							class="border-none font-mono text-xs break-all underline underline-offset-2 hover:text-foreground"
							@click="emit('run', run.parent_run_id)"
						>
							{{ run.parent_run_id }}
						</button>
					</dd>
				</template>
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
				<RunGraph :nodes="nodes" @select="emit('job', $event)" @run="emit('run', $event)" />
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
	</ModalShell>
</template>
