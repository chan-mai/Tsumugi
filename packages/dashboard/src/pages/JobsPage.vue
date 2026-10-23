<script setup lang="ts">
import { Plus } from '@lucide/vue';
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { isUnauthorized, listJobs, type Job } from '../api';
import { TOGGLEABLE, toggleColumn, visible } from '../columns';
import BulkActions from '../components/BulkActions.vue';
import JobDetailPanel from '../components/JobDetailPanel.vue';
import DateRangeMenu from '../components/DateRangeMenu.vue';
import FilterMenu from '../components/FilterMenu.vue';
import JobsTable from '../components/JobsTable.vue';
import NewJobModal from '../components/NewJobModal.vue';
import PageHeader from '../components/PageHeader.vue';
import Pagination from '../components/Pagination.vue';
import SearchBox from '../components/SearchBox.vue';
import ViewMenu from '../components/ViewMenu.vue';
import { onRefresh } from '../composables/useAutoRefresh';
import { bindings, definitionsReady } from '../composables/useDefinitions';
import { useDetail } from '../composables/useDetail';
import { useQueryChoice, useQueryDate, useQueryInteger, useQueryText } from '../composables/useQueryState';
import { isJobId, SEARCH_FIELDS, type SearchField } from '../search';
import { button, ERROR_TEXT, MUTED_TEXT } from '../ui';

const STATES = ['SCHEDULED', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'STALLED'];

const SORTABLE = ['updated_at', 'binding', 'state', 'attempts'] as const;

const { t } = useI18n();

const route = useRoute();
const { openJob, openRun, close } = useDetail();
const jobId = computed(() => (typeof route.params.jobId === 'string' ? route.params.jobId : null));

const jobs = ref<Job[]>([]);
const total = ref(0);
const state = useQueryText('state');
const binding = useQueryText('binding');
const searchField = useQueryChoice<SearchField>('field', SEARCH_FIELDS, 'id');
const search = useQueryText('q');
const createdFrom = useQueryDate('created_from', 'start');
const createdTo = useQueryDate('created_to', 'end');
const page = useQueryInteger('page', 1, 1);
const pageSize = useQueryInteger('size', 20, 1);
const sort = useQueryChoice('sort', SORTABLE, 'updated_at');
const order = useQueryChoice('order', ['asc', 'desc'] as const, 'desc');
const picked = ref<string[]>([]);
const creating = ref(false);
const message = ref<string | null>(null);
const error = ref<string | null>(null);

const filtered = computed(() => state.value || binding.value || search.value || createdFrom.value !== null || createdTo.value !== null);
const selectedIds = computed(() => picked.value.filter((id) => jobs.value.some((job) => job.id === id)));

// 条件変更は先頭ページから, 同一tickの更新は1回の遷移
function filter(apply: () => void) {
	apply();
	page.value = 1;
}

// 障害調査はID起点が多い
function commitSearch(value: string) {
	if (searchField.value === 'id' && isJobId(value)) {
		void openJob(value);
		return;
	}
	filter(() => (search.value = value));
}

function resetFilters() {
	filter(() => {
		state.value = '';
		binding.value = '';
		search.value = '';
		createdFrom.value = null;
		createdTo.value = null;
	});
}

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
		const list = await listJobs({
			state: state.value || undefined,
			binding: binding.value || undefined,
			sort: sort.value,
			order: order.value,
			...(search.value ? { [searchField.value]: search.value } : {}),
			created_from: createdFrom.value ?? undefined,
			created_to: createdTo.value ?? undefined,
			limit: pageSize.value,
			offset: (page.value - 1) * pageSize.value,
		});
		if (stale()) return;
		appliedSequence = sequence;
		pending.value = false;
		jobs.value = list.jobs;
		total.value = list.total;
		error.value = null;
	} catch (e) {
		if (stale()) return;
		appliedSequence = sequence;
		pending.value = false;
		// HTMLは未認証でも返却, 認証要否はAPIの401で判明
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

// 詳細の開閉は対象外
const conditions = computed(() =>
	JSON.stringify([
		state.value,
		binding.value,
		searchField.value,
		search.value,
		createdFrom.value,
		createdTo.value,
		page.value,
		pageSize.value,
		sort.value,
		order.value,
	]),
);
watch(conditions, reloadForConditions);

// 応答遅延時の要求累積防止
onRefresh(() => inFlight === 0 && void load());
onMounted(load);

function sortBy(column: string) {
	const next = SORTABLE.find((key) => key === column);
	if (!next) return;
	filter(() => {
		if (sort.value === next) order.value = order.value === 'desc' ? 'asc' : 'desc';
		else {
			sort.value = next;
			order.value = 'desc';
		}
	});
}
</script>

<template>
	<PageHeader>
		<span v-if="message" :class="MUTED_TEXT">{{ message }}</span>
		<button type="button" :class="button('primary')" @click="creating = true">
			<Plus class="size-4" aria-hidden="true" />
			{{ t('common.job') }}
		</button>
	</PageHeader>

	<div class="space-y-4">
		<div class="flex flex-wrap items-center justify-between gap-2">
			<div class="flex flex-wrap items-center gap-2">
				<SearchBox
					:field="searchField"
					:value="search"
					@update:field="filter(() => (searchField = $event))"
					@update:value="commitSearch($event)"
				/>
				<FilterMenu
					:title="t('common.binding')"
					:options="bindings"
					:loading="!definitionsReady"
					:selected="binding"
					@select="filter(() => (binding = $event))"
				/>
				<FilterMenu
					:title="t('common.status')"
					:options="STATES"
					:selected="state"
					:label-of="(value) => t(`state.${value}`)"
					@select="filter(() => (state = $event))"
				/>
				<DateRangeMenu
					:from="createdFrom"
					:to="createdTo"
					@update:from="filter(() => (createdFrom = $event))"
					@update:to="filter(() => (createdTo = $event))"
				/>
				<button v-if="filtered" type="button" :class="button('ghost')" @click="resetFilters()">{{ t('common.reset') }}</button>
			</div>

			<div class="flex items-center gap-2">
				<span v-if="error" :class="ERROR_TEXT">{{ t('app.failedToLoad', { error }) }}</span>
				<BulkActions
					v-if="selectedIds.length > 0"
					:ids="selectedIds"
					@changed="
						picked = [];
						load();
					"
					@message="message = $event"
				/>
				<ViewMenu :options="TOGGLEABLE" :visible="visible" @toggle="toggleColumn" />
			</div>
		</div>

		<JobsTable
			:loading="pending"
			v-model:picked="picked"
			:jobs="jobs"
			:sort="sort"
			:desc="order === 'desc'"
			@select="openJob"
			@sort="sortBy"
			@changed="load"
			@message="message = $event"
		/>

		<Pagination
			v-if="!pending"
			:page="page - 1"
			:page-size="pageSize"
			:total="total"
			unit="jobs"
			@update:page="page = $event + 1"
			@update:page-size="filter(() => (pageSize = $event))"
		/>
	</div>

	<NewJobModal
		:open="creating"
		:bindings="bindings"
		@close="creating = false"
		@created="
			message = t('app.jobCreated');
			load();
		"
	/>

	<JobDetailPanel :job-id="jobId" @close="close('jobs')" @changed="load" @run="openRun" />
</template>
