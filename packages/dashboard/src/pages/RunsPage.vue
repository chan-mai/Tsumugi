<script setup lang="ts">
import { Plus } from '@lucide/vue';
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { isUnauthorized, listRuns, type Run } from '../api';
import FilterMenu from '../components/FilterMenu.vue';
import NewRunModal from '../components/NewRunModal.vue';
import PageHeader from '../components/PageHeader.vue';
import Pagination from '../components/Pagination.vue';
import RunDetailPanel from '../components/RunDetailPanel.vue';
import RunsTable from '../components/RunsTable.vue';
import { onRefresh } from '../composables/useAutoRefresh';
import { flows, definitionsReady } from '../composables/useDefinitions';
import { useDetail } from '../composables/useDetail';
import { useQueryChoice, useQueryInteger, useQueryText } from '../composables/useQueryState';
import { button, ERROR_TEXT, MUTED_TEXT } from '../ui';

const STATES = ['RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;

const { t } = useI18n();
const route = useRoute();
const { openJob, openRun, close } = useDetail();
const runId = computed(() => (typeof route.params.runId === 'string' ? route.params.runId : null));

const runs = ref<Run[]>([]);
const total = ref(0);
const state = useQueryChoice<(typeof STATES)[number] | ''>('state', ['', ...STATES], '');
const flow = useQueryText('flow');
const page = useQueryInteger('page', 1, 1);
const pageSize = useQueryInteger('size', 20, 1);
const starting = ref(false);
const message = ref<string | null>(null);
const error = ref<string | null>(null);

// 定期更新では据え置き, 応答遅延時の全件破棄回避
let conditionGeneration = 0;
let requestSequence = 0;
let appliedSequence = 0;
let inFlight = 0;
// 現在条件の応答待ち, 旧条件の結果表示防止
const pending = ref(true);

async function load() {
	const generation = conditionGeneration;
	const sequence = ++requestSequence;
	const stale = () => generation !== conditionGeneration || sequence < appliedSequence;
	inFlight++;
	try {
		const list = await listRuns({
			state: state.value || undefined,
			flow: flow.value || undefined,
			limit: pageSize.value,
			offset: (page.value - 1) * pageSize.value,
		});
		if (stale()) return;
		appliedSequence = sequence;
		pending.value = false;
		runs.value = list.runs;
		total.value = list.total;
		error.value = null;
	} catch (e) {
		if (stale()) return;
		appliedSequence = sequence;
		pending.value = false;
		if (isUnauthorized(e)) return;
		error.value = e instanceof Error ? e.message : String(e);
	} finally {
		inFlight--;
	}
}

function reloadForConditions() {
	conditionGeneration++;
	pending.value = true;
	void load();
}

// 条件変更は先頭ページから, 同一tickの更新は1回の遷移
function filter(apply: () => void) {
	apply();
	page.value = 1;
}

// 詳細の開閉は対象外
const conditions = computed(() => JSON.stringify([state.value, flow.value, page.value, pageSize.value]));
watch(conditions, reloadForConditions);

onRefresh(() => inFlight === 0 && void load());
onMounted(load);
</script>

<template>
	<PageHeader>
		<span v-if="message" :class="MUTED_TEXT">{{ message }}</span>
		<button type="button" :class="button('primary')" @click="starting = true">
			<Plus class="size-4" aria-hidden="true" />
			{{ t('common.run') }}
		</button>
	</PageHeader>

	<div class="space-y-4">
		<div class="flex flex-wrap items-center gap-2">
			<FilterMenu
				:title="t('common.flow')"
				:options="flows"
				:loading="!definitionsReady"
				:selected="flow"
				@select="filter(() => (flow = $event))"
			/>
			<FilterMenu
				:title="t('common.status')"
				:options="[...STATES]"
				:selected="state"
				:label-of="(value) => t(`state.${value}`)"
				@select="filter(() => (state = $event as typeof state))"
			/>
			<button
				v-if="state || flow"
				type="button"
				:class="button('ghost')"
				@click="
					filter(() => {
						state = '';
						flow = '';
					})
				"
			>
				{{ t('common.reset') }}
			</button>
			<span v-if="error" :class="ERROR_TEXT">{{ t('app.failedToLoad', { error }) }}</span>
		</div>

		<RunsTable :loading="pending" :runs="runs" @select="openRun" />

		<Pagination
			v-if="!pending"
			:page="page - 1"
			:page-size="pageSize"
			:total="total"
			unit="runs"
			@update:page="page = $event + 1"
			@update:page-size="filter(() => (pageSize = $event))"
		/>
	</div>

	<NewRunModal
		:open="starting"
		:flows="flows"
		@close="starting = false"
		@created="
			message = t('app.runStarted');
			load();
		"
	/>

	<RunDetailPanel :run-id="runId" @close="close('runs')" @changed="load" @job="openJob" @run="openRun" />
</template>
