<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { getJob, type Attempt, type Job } from '../api';
import { formatTimestamp } from '../time';
import { button, CODE, ERROR_TEXT, LINK } from '../ui';
import { useJobActions } from '../useJobActions';
import AttemptLog from './AttemptLog.vue';
import LoadingState from './LoadingState.vue';
import SidePanel from './SidePanel.vue';
import StatusCell from './StatusCell.vue';

const props = defineProps<{ jobId: string | null }>();
const emit = defineEmits<{ close: []; changed: []; run: [string] }>();
const { t } = useI18n();

const job = ref<Job | null>(null);
const attempts = ref<Attempt[]>([]);
const error = ref<string | null>(null);
const message = ref<string | null>(null);
const loading = ref(false);
let loadSequence = 0;

const { busy, canRetry, canCancel, goneReason, act, reset } = useJobActions(job);

async function load(id: string) {
	const sequence = ++loadSequence;
	loading.value = true;
	try {
		const loaded = (await getJob(id)).job;
		if (sequence !== loadSequence || props.jobId !== id) return;
		job.value = loaded;
		error.value = null;
		attempts.value = loaded.attempts_log ?? [];
	} catch (e) {
		if (sequence !== loadSequence || props.jobId !== id) return;
		error.value = e instanceof Error ? e.message : String(e);
	} finally {
		if (sequence === loadSequence) loading.value = false;
	}
}

watch(
	() => props.jobId,
	async (id) => {
		loadSequence++;
		loading.value = false;
		if (!id) return;
		// 閉じるアニメーション中の内容消失防止、開く時のみ差し替え
		job.value = null;
		attempts.value = [];
		error.value = null;
		message.value = null;
		reset();
		await load(id);
	},
	{ immediate: true },
);

async function run(kind: 'retry' | 'cancel') {
	const id = props.jobId;
	if (!id) return;
	const outcome = await act(kind, id);
	if (outcome === null) return;
	if (props.jobId === id) {
		message.value = outcome;
		await load(id);
	} else {
		// 応答前に別Jobへ移動
		reset();
	}
	emit('changed');
}

const at = (value: number | null | undefined) => (value === null || value === undefined ? '-' : formatTimestamp(value));

const pretty = (payload: string | undefined) => {
	if (!payload) return '';
	try {
		return JSON.stringify(JSON.parse(payload), null, 2);
	} catch {
		return payload;
	}
};

const DT = 'text-ink-muted';
</script>

<template>
	<SidePanel :open="jobId !== null" :title="job?.binding ?? t('job.title')" @close="emit('close')">
		<p v-if="error" :class="ERROR_TEXT">{{ t('app.failedToLoad', { error }) }}</p>
		<LoadingState v-else-if="!job" />
		<div v-if="job" class="space-y-6 text-sm">
			<dl class="grid gap-y-2.5 sm:grid-cols-[10rem_1fr]">
				<dt :class="DT">{{ t('common.status') }}</dt>
				<dd><StatusCell :state="job.state" /></dd>
				<dt :class="DT">{{ t('common.id') }}</dt>
				<dd class="font-mono text-xs break-all">{{ job.id }}</dd>
				<template v-if="job.run_id">
					<dt :class="DT">{{ t('common.run') }}</dt>
					<dd>
						<button type="button" :class="LINK" @click="emit('run', job.run_id)">{{ job.run_id }}</button>
						<span v-if="job.node_id" class="ml-1 text-xs text-ink-subtle">{{ job.node_id }}</span>
					</dd>
				</template>
				<dt :class="DT">{{ t('common.attempts') }}</dt>
				<dd class="tabular-nums">{{ job.attempts }} / {{ job.max_attempts }}</dd>
				<template v-if="job.progress !== null && job.progress !== undefined">
					<dt :class="DT">{{ t('job.progress') }}</dt>
					<dd class="flex items-center gap-2">
						<span class="h-1.5 w-32 overflow-hidden rounded-full bg-neutral-soft">
							<span class="block h-full rounded-full bg-accent" :style="{ width: `${Math.round(job.progress * 100)}%` }" />
						</span>
						<span class="tabular-nums">{{ Math.round(job.progress * 100) }}%</span>
					</dd>
				</template>
				<dt :class="DT">{{ t('job.guarantee') }}</dt>
				<dd>{{ job.guarantee ?? '-' }}</dd>
				<dt :class="DT">{{ t('job.priority') }}</dt>
				<dd class="tabular-nums">{{ job.priority }}</dd>
				<template v-if="job.concurrency_key">
					<dt :class="DT">{{ t('job.concurrencyKey') }}</dt>
					<dd class="break-all">{{ job.concurrency_key }}</dd>
				</template>
				<template v-if="job.unique_key">
					<dt :class="DT">{{ t('job.uniqueKey') }}</dt>
					<dd class="break-all">{{ job.unique_key }}</dd>
				</template>
				<template v-if="job.traceparent">
					<dt :class="DT">{{ t('job.traceparent') }}</dt>
					<dd class="font-mono text-xs break-all">{{ job.traceparent }}</dd>
				</template>
				<dt :class="DT">{{ t('common.createdAt') }}</dt>
				<dd>{{ at(job.created_at) }}</dd>
				<template v-if="job.expires_at !== null && job.expires_at !== undefined">
					<dt :class="DT">{{ t('job.expiresAt') }}</dt>
					<dd>{{ at(job.expires_at) }}</dd>
				</template>
				<template v-if="job.cancel_requested_at !== null && job.cancel_requested_at !== undefined">
					<dt :class="DT">{{ t('job.cancelRequestedAt') }}</dt>
					<dd>{{ at(job.cancel_requested_at) }}</dd>
				</template>
				<dt :class="DT">{{ t('common.startedAt') }}</dt>
				<dd>{{ at(job.dispatched_at) }}</dd>
				<dt :class="DT">{{ t('common.updatedAt') }}</dt>
				<dd>{{ at(job.updated_at) }}</dd>
			</dl>

			<section>
				<h3 class="mb-2 text-base font-semibold">{{ t('job.payload') }}</h3>
				<pre :class="CODE">{{ pretty(job.payload) }}</pre>
			</section>

			<AttemptLog :attempts="attempts" />

			<section v-if="job.logs?.length">
				<h3 class="mb-2 text-base font-semibold">{{ t('job.logs') }}</h3>
				<ol class="space-y-2">
					<li v-for="(entry, index) in job.logs" :key="index" class="rounded-xl border border-line p-3">
						<p class="mb-1 text-xs text-ink-subtle">{{ t('job.logHeading', { attempt: entry.attempt, at: at(entry.timestamp) }) }}</p>
						<pre class="font-mono text-xs break-words whitespace-pre-wrap">{{ entry.message }}</pre>
					</li>
				</ol>
			</section>
		</div>

		<template v-if="job" #footer>
			<button type="button" :class="button('secondary')" :disabled="busy || loading || !canRetry" :title="goneReason" @click="run('retry')">
				{{ t('common.retry') }}
			</button>
			<button
				type="button"
				:class="button('danger')"
				:disabled="busy || loading || !canCancel"
				:title="t('jobs.cancelHint')"
				@click="run('cancel')"
			>
				{{ t('common.cancel') }}
			</button>
			<span v-if="message" class="text-xs text-ink-muted">{{ message }}</span>
			<button type="button" :class="button('ghost')" class="ml-auto" :disabled="busy || loading" @click="jobId && load(jobId)">
				{{ t('common.refresh') }}
			</button>
		</template>
	</SidePanel>
</template>
