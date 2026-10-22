<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import BindingsView from './components/BindingsView.vue';
import BulkActions from './components/BulkActions.vue';
import CheckBox from './components/CheckBox.vue';
import DateRangeMenu from './components/DateRangeMenu.vue';
import FilterMenu from './components/FilterMenu.vue';
import JobDetailModal from './components/JobDetailModal.vue';
import MetricsView from './components/MetricsView.vue';
import NewJobModal from './components/NewJobModal.vue';
import NewRunModal from './components/NewRunModal.vue';
import Pagination from './components/Pagination.vue';
import RefreshMenu from './components/RefreshMenu.vue';
import RowActions from './components/RowActions.vue';
import RunDetailModal from './components/RunDetailModal.vue';
import SchedulesView from './components/SchedulesView.vue';
import SearchBox from './components/SearchBox.vue';
import SortHeader from './components/SortHeader.vue';
import StatusCell from './components/StatusCell.vue';
import TokenPrompt from './components/TokenPrompt.vue';
import ViewMenu from './components/ViewMenu.vue';
import {
	getBindings,
	getFlows,
	getMetrics,
	isMetricsUnavailable,
	isUnauthorized,
	listJobs,
	listRuns,
	listSchedules,
	tokenCookie,
	type Job,
	type Run,
} from './api';
import { loadRefresh, REFRESH_KEY } from './refresh';
import { isJobId, type SearchField } from './search';
import { formatTimestamp } from './time';

const STATES = ['SCHEDULED', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'STALLED'];
const RUN_STATES = ['RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'];

const jobs = ref<Job[]>([]);
const total = ref(0);
const bindings = ref<string[]>([]);
const state = ref('');
const binding = ref('');
const searchField = ref<SearchField>('id');
const search = ref('');
const createdFrom = ref<number | null>(null);
const createdTo = ref<number | null>(null);
const page = ref(0);
const pageSize = ref(20);
const sort = ref('updated_at');
const desc = ref(true);
const selected = ref<string | null>(null);
const picked = ref<string[]>([]);
const creating = ref(false);
const message = ref<string | null>(null);
const error = ref<string | null>(null);
const unauthorized = ref(false);
const refreshMs = ref(loadRefresh(localStorage));
const canPromptToken = tokenCookie() !== null;
let timer: ReturnType<typeof setInterval> | undefined;

const tab = ref<'jobs' | 'runs' | 'schedules' | 'bindings' | 'metrics'>('jobs');
const hasMetrics = ref(false);
const hasSchedules = ref(false);
const tabs = computed(
	() =>
		[
			'jobs',
			...(flows.value.length > 0 ? ['runs'] : []),
			...(hasSchedules.value ? ['schedules'] : []),
			'bindings',
			...(hasMetrics.value ? ['metrics'] : []),
		] as const,
);
const isList = computed(() => tab.value === 'jobs' || tab.value === 'runs');
const flows = ref<string[]>([]);
const runs = ref<Run[]>([]);
const runFlow = ref('');
const selectedRun = ref<string | null>(null);
const startingRun = ref(false);
const metricsView = ref<InstanceType<typeof MetricsView> | null>(null);
const schedulesView = ref<InstanceType<typeof SchedulesView> | null>(null);
const bindingsView = ref<InstanceType<typeof BindingsView> | null>(null);

const searchParam = () => (search.value ? { [searchField.value]: search.value } : {});

// 障害調査はID起点が多い
function commitSearch(value: string) {
	search.value = value;
	if (searchField.value === 'id' && isJobId(value)) selected.value = value;
}

// 定期更新では据え置き, 応答遅延時の全件破棄回避
let conditionGeneration = 0;
let requestSequence = 0;
let appliedSequence = 0;
let inFlight = 0;
// 登録済みbindingとflowはデプロイまで不変, 取得成功後は再取得なし
let definitionsLoaded = false;

async function loadDefinitions() {
	if (definitionsLoaded) return;
	const [available, definedFlows] = await Promise.all([getBindings(), getFlows()]);
	bindings.value = available.bindings;
	flows.value = definedFlows.flows;
	definitionsLoaded = true;
}

function reloadForConditions() {
	conditionGeneration++;
	load();
}

async function load() {
	const generation = conditionGeneration;
	const sequence = ++requestSequence;
	const requested = tab.value;
	const stale = () => generation !== conditionGeneration || sequence < appliedSequence;
	inFlight++;
	try {
		if (requested === 'metrics') {
			await metricsView.value?.load();
			return;
		}
		if (requested === 'schedules') {
			await schedulesView.value?.load();
			return;
		}
		if (requested === 'bindings') {
			await bindingsView.value?.load();
			return;
		}
		if (requested === 'runs') {
			const [list] = await Promise.all([
				listRuns({
					state: state.value || undefined,
					flow: runFlow.value || undefined,
					limit: pageSize.value,
					offset: page.value * pageSize.value,
				}),
				loadDefinitions(),
			]);
			if (stale()) return;
			appliedSequence = sequence;
			runs.value = list.runs;
			total.value = list.total;
			error.value = null;
			unauthorized.value = false;
			return;
		}

		const [list] = await Promise.all([
			listJobs({
				state: state.value || undefined,
				binding: binding.value || undefined,
				sort: sort.value,
				order: desc.value ? 'desc' : 'asc',
				...searchParam(),
				created_from: createdFrom.value ?? undefined,
				created_to: createdTo.value ?? undefined,
				limit: pageSize.value,
				offset: page.value * pageSize.value,
			}),
			loadDefinitions(),
		]);
		if (stale()) return;
		appliedSequence = sequence;
		jobs.value = list.jobs;
		total.value = list.total;
		error.value = null;
		unauthorized.value = false;
	} catch (e) {
		if (stale()) return;
		appliedSequence = sequence;
		if (isUnauthorized(e)) {
			// HTMLは未認証でも返却, 認証要否はここで判明
			unauthorized.value = true;
			return;
		}
		error.value = e instanceof Error ? e.message : String(e);
	} finally {
		inFlight--;
	}
}

// 前回未完了と非表示中は省略, 応答遅延時の要求の累積防止
function tick() {
	if (inFlight > 0 || document.hidden) return;
	load();
}

function switchTab(next: 'jobs' | 'runs' | 'schedules' | 'bindings' | 'metrics') {
	if (tab.value === next) return;
	tab.value = next;
	resetFilters();
	page.value = 0;
	reloadForConditions();
}

function resetFilters() {
	state.value = '';
	binding.value = '';
	runFlow.value = '';
	search.value = '';
	createdFrom.value = null;
	createdTo.value = null;
}

const progressOf = (run: Run) => `${run.node_done} / ${run.node_total}`;

const selectedIds = computed(() => picked.value.filter((id) => jobs.value.some((job) => job.id === id)));
const allPicked = computed(() => jobs.value.length > 0 && jobs.value.every((job) => picked.value.includes(job.id)));

function clearSelection() {
	picked.value = [];
}

function togglePick(id: string) {
	picked.value = picked.value.includes(id) ? picked.value.filter((value) => value !== id) : [...picked.value, id];
}

function toggleAll() {
	picked.value = allPicked.value ? [] : jobs.value.map((job) => job.id);
}

function restartTimer() {
	if (timer) clearInterval(timer);
	if (refreshMs.value > 0) timer = setInterval(tick, refreshMs.value);
}

function setRefresh(ms: number) {
	refreshMs.value = ms;
	restartTimer();
	try {
		localStorage.setItem(REFRESH_KEY, String(ms));
	} catch {
		// プライベートモード等の書き込み不可, 選択自体は継続
	}
}

watch([state, binding, runFlow, searchField, search, createdFrom, createdTo, pageSize, sort, desc], () => {
	page.value = 0;
	reloadForConditions();
});
watch(page, reloadForConditions);

function sortBy(column: string) {
	if (sort.value === column) desc.value = !desc.value;
	else {
		sort.value = column;
		desc.value = true;
	}
}

// 未設定は501, 認証前の401はトークン入力後に再確認
async function detectFeatures() {
	const [metrics, schedules] = await Promise.allSettled([getMetrics({ hours: 24 }), listSchedules()]);
	// 501, 401以外の失敗はタブ表示, 理由は各画面で表示
	const available = (result: PromiseSettledResult<unknown>) =>
		result.status === 'fulfilled' || (!isMetricsUnavailable(result.reason) && !isUnauthorized(result.reason));
	hasMetrics.value = available(metrics);
	hasSchedules.value = available(schedules);
}

// jobs / runs以外のタブは再マウント時に各自で読込, 401なら再びトークン入力へ
function reload() {
	unauthorized.value = false;
	// トークン入力前の要求の401応答を破棄
	reloadForConditions();
	detectFeatures();
}

onMounted(() => {
	load();
	restartTimer();
	detectFeatures();
});
onUnmounted(() => timer && clearInterval(timer));

const at = (value: number | null) => (value === null ? '' : formatTimestamp(value));
const durationOf = (job: Job) =>
	job.dispatched_at && job.updated_at > job.dispatched_at ? `${job.updated_at - job.dispatched_at} ms` : '';

// 狭い画面での操作性確保、重要度の低い列から非表示
const COLUMN = {
	id: 'hidden lg:table-cell',
	startedAt: 'hidden xl:table-cell',
	updatedAt: 'hidden md:table-cell',
	attempts: 'hidden sm:table-cell',
	processingTime: 'hidden xl:table-cell',
};
const HEAD = 'h-12 px-4 text-left align-middle font-medium text-muted-foreground whitespace-nowrap';

// Binding, Statusは行識別用に固定
const TOGGLEABLE = [
	{ key: 'id', label: 'ID' },
	{ key: 'startedAt', label: 'Started at' },
	{ key: 'updatedAt', label: 'Updated at' },
	{ key: 'attempts', label: 'Attempts' },
	{ key: 'processingTime', label: 'Processing time' },
];
const VIEW_KEY = 'tsumugi:columns';

function loadVisible(): Record<string, boolean> {
	const all = Object.fromEntries(TOGGLEABLE.map((c) => [c.key, true]));
	try {
		return { ...all, ...(JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') as Record<string, boolean>) };
	} catch {
		return all;
	}
}

const visible = ref(loadVisible());

function toggleColumn(key: string) {
	visible.value = { ...visible.value, [key]: !visible.value[key] };
	try {
		localStorage.setItem(VIEW_KEY, JSON.stringify(visible.value));
	} catch {
		// プライベートモード等の書き込み不可, 表示自体は継続
	}
}

const columnClass = (key: keyof typeof COLUMN) => (visible.value[key] ? COLUMN[key] : 'hidden');
</script>

<template>
	<TokenPrompt v-if="unauthorized && canPromptToken" @saved="reload" />

	<div v-else-if="unauthorized" class="mx-auto mt-24 max-w-sm px-4 text-center">
		<h1 class="mb-2 text-xl font-bold">Tsumugi</h1>
		<p class="text-sm text-muted-foreground">Not authorized. Sign in through your identity provider and reload.</p>
	</div>

	<div v-else class="p-4 sm:p-8">
		<header class="mb-6 flex flex-wrap items-center gap-4">
			<h1 class="text-xl font-bold">Tsumugi</h1>
			<nav class="flex items-center gap-1 text-sm">
				<button
					v-for="option in tabs"
					:key="option"
					type="button"
					class="h-8 rounded-card border-none px-3 capitalize"
					:class="tab === option ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent'"
					@click="switchTab(option)"
				>
					{{ option }}
				</button>
			</nav>
		</header>

		<div class="space-y-4">
			<div class="flex flex-wrap items-center justify-between gap-2">
				<div v-if="isList" class="flex flex-wrap items-center gap-2">
					<SearchBox
						v-if="tab === 'jobs'"
						:field="searchField"
						:value="search"
						@update:field="searchField = $event"
						@update:value="commitSearch($event)"
					/>
					<FilterMenu v-if="tab === 'jobs'" title="Binding" :options="bindings" :selected="binding" @select="binding = $event" />
					<FilterMenu v-else title="Flow" :options="flows" :selected="runFlow" @select="runFlow = $event" />
					<FilterMenu title="Status" :options="tab === 'jobs' ? STATES : RUN_STATES" :selected="state" @select="state = $event" />
					<DateRangeMenu
						v-if="tab === 'jobs'"
						:from="createdFrom"
						:to="createdTo"
						@update:from="createdFrom = $event"
						@update:to="createdTo = $event"
					/>
					<button
						v-if="state || binding || runFlow || search || createdFrom !== null || createdTo !== null"
						type="button"
						class="h-8 rounded-card border-none px-2 text-sm text-muted-foreground hover:bg-accent"
						@click="resetFilters()"
					>
						Reset
					</button>
				</div>

				<div class="flex items-center gap-2">
					<span v-if="message" class="text-sm text-muted-foreground">{{ message }}</span>
					<span v-if="error" class="text-sm text-destructive">Failed to load: {{ error }}</span>
					<div v-if="!isList" class="grow" />
					<!-- 他タブでは選択対象が不可視, 一括操作も非表示 -->
					<BulkActions
						v-if="tab === 'jobs' && selectedIds.length > 0"
						:ids="selectedIds"
						@changed="
							clearSelection();
							load();
						"
						@message="message = $event"
					/>
					<ViewMenu v-if="tab === 'jobs'" :options="TOGGLEABLE" :visible="visible" @toggle="toggleColumn" />
					<RefreshMenu :interval="refreshMs" @update:interval="setRefresh" />
					<button
						v-if="isList"
						type="button"
						class="flex h-8 items-center gap-1.5 rounded-card border-none bg-primary px-3 text-sm text-primary-foreground"
						@click="tab === 'jobs' ? (creating = true) : (startingRun = true)"
					>
						<svg viewBox="0 0 16 16" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
							<path d="M8 3.5v9M3.5 8h9" />
						</svg>
						{{ tab === 'jobs' ? 'Job' : 'Run' }}
					</button>
				</div>
			</div>

			<MetricsView v-if="tab === 'metrics'" ref="metricsView" :bindings="bindings" @unauthorized="unauthorized = true" />

			<SchedulesView
				v-else-if="tab === 'schedules'"
				ref="schedulesView"
				@unauthorized="unauthorized = true"
				@job="selected = $event"
				@run="selectedRun = $event"
			/>

			<BindingsView v-else-if="tab === 'bindings'" ref="bindingsView" @unauthorized="unauthorized = true" />

			<div v-else-if="tab === 'runs'" class="relative w-full overflow-x-auto rounded-card border border-border">
				<table class="w-full caption-bottom text-sm">
					<thead class="[&_tr]:border-b [&_tr]:border-border">
						<tr>
							<th :class="HEAD">Flow</th>
							<th :class="[HEAD, columnClass('id')]">ID</th>
							<th :class="HEAD">Status</th>
							<th :class="HEAD">Nodes</th>
							<th :class="[HEAD, columnClass('updatedAt')]">Updated at</th>
						</tr>
					</thead>
					<tbody class="[&_tr:last-child]:border-0">
						<tr
							v-for="run in runs"
							:key="run.id"
							class="cursor-pointer border-b border-border transition-colors hover:bg-muted"
							@click="selectedRun = run.id"
						>
							<td class="p-4 align-middle">
								{{ run.flow }}
								<!-- ID列非表示の幅での行識別用 -->
								<span class="block font-mono text-xs break-all text-muted-foreground lg:hidden">{{ run.id }}</span>
							</td>
							<td class="p-4 align-middle font-mono text-xs text-muted-foreground" :class="columnClass('id')">{{ run.id }}</td>
							<td class="p-4 align-middle"><StatusCell :state="run.state" /></td>
							<td class="p-4 align-middle tabular-nums">
								{{ progressOf(run) }}
								<span v-if="run.node_failed > 0" class="text-destructive">({{ run.node_failed }})</span>
							</td>
							<td class="p-4 align-middle whitespace-nowrap" :class="columnClass('updatedAt')">{{ at(run.updated_at) }}</td>
						</tr>
						<tr v-if="runs.length === 0">
							<td colspan="5" class="h-24 text-center text-muted-foreground">No results.</td>
						</tr>
					</tbody>
				</table>
			</div>

			<div v-else class="relative w-full overflow-x-auto rounded-card border border-border">
				<table class="w-full caption-bottom text-sm">
					<thead class="[&_tr]:border-b [&_tr]:border-border">
						<tr>
							<th class="h-12 w-10 pl-4">
								<button
									type="button"
									class="flex size-6 items-center justify-center rounded-sm border-none hover:bg-accent"
									aria-label="Select all rows"
									@click="toggleAll"
								>
									<CheckBox :checked="allPicked" />
								</button>
							</th>
							<th :class="HEAD">
								<SortHeader label="Binding" column="binding" :sort="sort" :desc="desc" @sort="sortBy" />
							</th>
							<th :class="[HEAD, columnClass('id')]">ID</th>
							<th :class="HEAD">
								<SortHeader label="Status" column="state" :sort="sort" :desc="desc" @sort="sortBy" />
							</th>
							<th :class="[HEAD, columnClass('startedAt')]">Started at</th>
							<th :class="[HEAD, columnClass('updatedAt')]">
								<SortHeader label="Updated at" column="updated_at" :sort="sort" :desc="desc" @sort="sortBy" />
							</th>
							<th :class="[HEAD, columnClass('attempts')]">
								<SortHeader label="Attempts" column="attempts" :sort="sort" :desc="desc" @sort="sortBy" />
							</th>
							<th :class="[HEAD, columnClass('processingTime')]">Processing time</th>
							<th class="h-12 w-12 px-4" />
						</tr>
					</thead>
					<tbody class="[&_tr:last-child]:border-0">
						<tr
							v-for="job in jobs"
							:key="job.id"
							class="cursor-pointer border-b border-border transition-colors hover:bg-muted"
							@click="selected = job.id"
						>
							<td class="pl-4 align-middle" @click.stop>
								<button
									type="button"
									class="flex size-6 items-center justify-center rounded-sm border-none hover:bg-accent"
									:aria-label="`Select ${job.id}`"
									@click="togglePick(job.id)"
								>
									<CheckBox :checked="picked.includes(job.id)" />
								</button>
							</td>
							<td class="p-4 align-middle">
								{{ job.binding }}
								<!-- ID列非表示の幅での行識別用 -->
								<span v-if="visible.id" class="block font-mono text-xs break-all text-muted-foreground lg:hidden">{{ job.id }}</span>
							</td>
							<td class="p-4 align-middle font-mono text-xs text-muted-foreground" :class="columnClass('id')">{{ job.id }}</td>
							<td class="p-4 align-middle"><StatusCell :state="job.state" /></td>
							<td class="p-4 align-middle whitespace-nowrap" :class="columnClass('startedAt')">{{ at(job.dispatched_at) }}</td>
							<td class="p-4 align-middle whitespace-nowrap" :class="columnClass('updatedAt')">{{ at(job.updated_at) }}</td>
							<td class="p-4 align-middle tabular-nums" :class="columnClass('attempts')">{{ job.attempts }} / {{ job.max_attempts }}</td>
							<td class="p-4 align-middle tabular-nums" :class="columnClass('processingTime')">{{ durationOf(job) }}</td>
							<td class="p-4 align-middle" @click.stop>
								<RowActions :job-id="job.id" :state="job.state" :retryable="job.retryable" @changed="load" @message="message = $event" />
							</td>
						</tr>
						<tr v-if="jobs.length === 0">
							<td colspan="9" class="h-24 text-center text-muted-foreground">No results.</td>
						</tr>
					</tbody>
				</table>
			</div>

			<Pagination v-if="isList" v-model:page="page" v-model:page-size="pageSize" :total="total" :unit="tab" />
		</div>

		<JobDetailModal
			:job-id="selected"
			@close="selected = null"
			@changed="load"
			@run="
				selected = null;
				selectedRun = $event;
			"
		/>
		<NewJobModal
			:open="creating"
			:bindings="bindings"
			@close="creating = false"
			@created="
				message = 'Job created';
				load();
			"
		/>
		<RunDetailModal
			:run-id="selectedRun"
			@close="selectedRun = null"
			@changed="load"
			@job="
				selectedRun = null;
				selected = $event;
			"
			@run="selectedRun = $event"
		/>
		<NewRunModal
			:open="startingRun"
			:flows="flows"
			@close="startingRun = false"
			@created="
				message = 'Run started';
				load();
			"
		/>
	</div>
</template>
