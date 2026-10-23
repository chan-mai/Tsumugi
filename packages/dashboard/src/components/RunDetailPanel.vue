<script setup lang="ts">
import { useStorage } from '@vueuse/core';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { cancelRun, getRun, retryRun, type Run, type RunNode } from '../api';
import { onRefresh } from '../composables/useAutoRefresh';
import { confirmAction } from '../composables/useConfirm';
import { formatTimestamp } from '../time';
import { button, CODE, ERROR_TEXT, LINK } from '../ui';
import LoadingState from './LoadingState.vue';
import RunGraph from './RunGraph.vue';
import SidePanel from './SidePanel.vue';
import StatusCell from './StatusCell.vue';
import RunWaterfall from './waterfall/RunWaterfall.vue';

const props = defineProps<{ runId: string | null }>();
const emit = defineEmits<{ close: []; changed: []; job: [jobId: string]; run: [runId: string] }>();
const { t } = useI18n();

const view = useStorage<'waterfall' | 'graph'>('tsumugi:run-view', 'waterfall');

const run = ref<Run | null>(null);
const nodes = ref<RunNode[]>([]);
const error = ref<string | null>(null);
const message = ref<string | null>(null);
const busy = ref(false);
// 親子run間の高速移動時の旧応答上書き防止用連番
let loadSequence = 0;
let loading = false;

const canRetry = computed(() => run.value?.retryable === true);
const canCancel = computed(() => run.value?.state === 'RUNNING');

async function load(id: string) {
	const sequence = ++loadSequence;
	loading = true;
	try {
		const loaded = await getRun(id);
		if (sequence !== loadSequence || props.runId !== id) return;
		run.value = loaded.run;
		nodes.value = loaded.nodes;
		error.value = null;
	} catch (e) {
		if (sequence !== loadSequence || props.runId !== id) return;
		error.value = e instanceof Error ? e.message : String(e);
	} finally {
		if (sequence === loadSequence) loading = false;
	}
}

watch(
	() => props.runId,
	async (id) => {
		loadSequence++;
		loading = false;
		if (!id) return;
		// 閉じるアニメーション中の内容消失防止、開く時のみ差し替え
		run.value = null;
		nodes.value = [];
		error.value = null;
		message.value = null;
		await load(id);
	},
	{ immediate: true },
);

// 実行中のrunのみ再取得, 応答遅延時の要求累積防止
onRefresh(() => {
	if (props.runId && run.value?.state === 'RUNNING' && !loading) void load(props.runId);
});

async function act(kind: 'retry' | 'cancel') {
	if (!props.runId) return;
	const confirmed = await confirmAction({
		title: t(kind === 'retry' ? 'confirm.retryRun' : 'confirm.cancelRun'),
		message: props.runId,
		confirmLabel: t(kind === 'retry' ? 'common.retry' : 'common.cancel'),
		danger: kind === 'cancel',
	});
	if (!confirmed || !props.runId) return;
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

const DT = 'text-ink-muted';
const TAB = 'border-x-0 border-t-0 border-b-2 bg-transparent px-1 pb-2 text-sm';
</script>

<template>
	<SidePanel :open="runId !== null" :title="run?.flow ?? t('run.title')" @close="emit('close')">
		<p v-if="error" :class="ERROR_TEXT">{{ t('app.failedToLoad', { error }) }}</p>
		<LoadingState v-else-if="!run" />
		<div v-else class="space-y-6 text-sm">
			<dl class="grid gap-y-2.5 sm:grid-cols-[10rem_1fr]">
				<dt :class="DT">{{ t('common.status') }}</dt>
				<dd><StatusCell :state="run.state" /></dd>
				<dt :class="DT">{{ t('common.id') }}</dt>
				<dd class="font-mono text-xs break-all">{{ run.id }}</dd>
				<template v-if="run.parent_run_id">
					<dt :class="DT">{{ t('run.parentRun') }}</dt>
					<dd>
						<button type="button" :class="LINK" @click="emit('run', run.parent_run_id)">{{ run.parent_run_id }}</button>
					</dd>
				</template>
				<dt :class="DT">{{ t('run.nodes') }}</dt>
				<dd class="tabular-nums">
					{{ run.node_done }} / {{ run.node_total }}
					<span v-if="run.node_failed > 0" class="text-critical">{{ t('run.failedCount', { count: run.node_failed }) }}</span>
				</dd>
				<dt :class="DT">{{ t('common.createdAt') }}</dt>
				<dd>{{ at(run.created_at) }}</dd>
				<dt :class="DT">{{ t('common.updatedAt') }}</dt>
				<dd>{{ at(run.updated_at) }}</dd>
			</dl>

			<section>
				<div class="mb-3 flex gap-5 border-b border-line" role="tablist">
					<button
						v-for="option in ['waterfall', 'graph'] as const"
						:key="option"
						type="button"
						role="tab"
						:aria-selected="view === option"
						:class="[
							TAB,
							view === option ? 'border-accent-strong font-medium text-ink' : 'border-transparent text-ink-muted hover:text-ink',
						]"
						class="-mb-px"
						@click="view = option"
					>
						{{ t(`run.${option}`) }}
					</button>
				</div>
				<RunWaterfall v-if="view === 'waterfall'" :nodes="nodes" @select="emit('job', $event)" @run="emit('run', $event)" />
				<RunGraph v-else :nodes="nodes" @select="emit('job', $event)" @run="emit('run', $event)" />
			</section>

			<section>
				<h3 class="mb-2 text-base font-semibold">{{ t('run.input') }}</h3>
				<pre :class="CODE">{{ pretty(run.input) }}</pre>
			</section>
		</div>

		<template v-if="run" #footer>
			<button type="button" :class="button('secondary')" :disabled="busy || !canRetry" :title="t('run.retryHint')" @click="act('retry')">
				{{ t('common.retry') }}
			</button>
			<button type="button" :class="button('danger')" :disabled="busy || !canCancel" :title="t('run.cancelHint')" @click="act('cancel')">
				{{ t('common.cancel') }}
			</button>
			<span v-if="message" class="text-xs text-ink-muted">{{ message }}</span>
		</template>
	</SidePanel>
</template>
