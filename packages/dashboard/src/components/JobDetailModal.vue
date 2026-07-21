<script setup lang="ts">
import { Dialog, DialogPanel, DialogTitle, TransitionChild, TransitionRoot } from '@headlessui/vue';
import { ref, watch } from 'vue';
import StatusCell from './StatusCell.vue';
import { getJob, type Job } from '../api';
import { useJobActions } from '../useJobActions';

const props = defineProps<{ jobId: string | null }>();
const emit = defineEmits<{ close: []; changed: [] }>();

const job = ref<Job | null>(null);
const error = ref<string | null>(null);
const message = ref<string | null>(null);

const { busy, canRetry, canCancel, goneReason, act, reset } = useJobActions(job);

async function load(id: string) {
	try {
		job.value = (await getJob(id)).job;
	} catch (e) {
		error.value = e instanceof Error ? e.message : String(e);
	}
}

watch(
	() => props.jobId,
	async (id) => {
		if (!id) return;
		// 閉じるアニメーションの間に中身が消えないよう,開く時だけ差し替える
		job.value = null;
		error.value = null;
		message.value = null;
		reset();
		await load(id);
	},
);

async function run(kind: 'retry' | 'cancel') {
	if (!props.jobId) return;
	message.value = await act(kind, props.jobId);
	// 投影は数秒遅れるので即時には変わらないが,反映され次第この再読込で追いつく
	await load(props.jobId);
	emit('changed');
}

const at = (value: number | null | undefined) => (value ? new Date(value).toLocaleString() : '-');

const pretty = (payload: string | undefined) => {
	if (!payload) return '';
	try {
		return JSON.stringify(JSON.parse(payload), null, 2);
	} catch {
		return payload;
	}
};
</script>

<template>
	<TransitionRoot :show="jobId !== null" as="template">
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
						class="relative max-h-[85vh] w-full max-w-2xl overflow-auto rounded-card border border-border bg-background p-4 shadow-lg sm:p-6"
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

						<DialogTitle class="mb-4 text-lg font-bold">Job detail</DialogTitle>

						<p v-if="error" class="text-sm text-destructive">Failed to load: {{ error }}</p>
						<p v-else-if="!job" class="text-sm text-muted-foreground">Loading</p>
						<div v-else class="space-y-4 text-sm">
							<dl class="grid gap-y-2 sm:grid-cols-[10rem_1fr]">
								<dt class="text-muted-foreground">Status</dt>
								<dd><StatusCell :state="job.state" /></dd>
								<dt class="text-muted-foreground">ID</dt>
								<dd class="font-mono text-xs break-all">{{ job.id }}</dd>
								<dt class="text-muted-foreground">Binding</dt>
								<dd>{{ job.binding }}</dd>
								<dt class="text-muted-foreground">Attempts</dt>
								<dd class="tabular-nums">{{ job.attempts }} / {{ job.max_attempts }}</dd>
								<dt class="text-muted-foreground">Guarantee</dt>
								<dd>{{ job.guarantee ?? '-' }}</dd>
								<dt class="text-muted-foreground">Priority</dt>
								<dd class="tabular-nums">{{ job.priority }}</dd>
								<dt class="text-muted-foreground">Concurrency key</dt>
								<dd>{{ job.concurrency_key ?? '-' }}</dd>
								<dt class="text-muted-foreground">Unique key</dt>
								<dd>{{ job.unique_key ?? '-' }}</dd>
								<dt class="text-muted-foreground">Created at</dt>
								<dd>{{ at(job.created_at) }}</dd>
								<dt class="text-muted-foreground">Started at</dt>
								<dd>{{ at(job.dispatched_at) }}</dd>
								<dt class="text-muted-foreground">Updated at</dt>
								<dd>{{ at(job.updated_at) }}</dd>
							</dl>

							<div>
								<p class="mb-1 text-muted-foreground">Payload</p>
								<pre class="overflow-auto rounded-card bg-muted p-3 text-xs">{{ pretty(job.payload) }}</pre>
							</div>

							<div class="flex flex-wrap items-center gap-2 border-t border-border pt-4">
								<button
									type="button"
									class="h-8 rounded-card border border-border px-3 text-sm"
									:class="canRetry ? 'bg-background hover:bg-accent' : 'cursor-not-allowed text-muted-foreground'"
									:disabled="busy || !canRetry"
									:title="goneReason"
									@click="run('retry')"
								>
									Retry
								</button>
								<button
									type="button"
									class="h-8 rounded-card border border-border px-3 text-sm"
									:class="canCancel ? 'bg-background text-destructive hover:bg-accent' : 'cursor-not-allowed text-muted-foreground'"
									:disabled="busy || !canCancel"
									title="Only scheduled jobs can be cancelled"
									@click="run('cancel')"
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
