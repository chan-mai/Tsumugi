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
/** runが取る4つ(ADR-0029) */
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

/** flowsを設定していない利用者にはrunの画面自体を非表示 */
const tab = ref<'jobs' | 'runs' | 'schedules' | 'bindings' | 'metrics'>('jobs');
/** Analytics Engineの設定がある構成でのみメトリクスのタブを表示 */
const hasMetrics = ref(false);
/** schedulesを定義した構成でのみ定期実行のタブを表示 */
const hasSchedules = ref(false);
/** 設定した機能のぶんだけタブを表示 */
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
/** 抽出条件とページングを持つのはjobsとrunsだけ, 他のタブは自前で読む */
const isList = computed(() => tab.value === 'jobs' || tab.value === 'runs');
const flows = ref<string[]>([]);
const runs = ref<Run[]>([]);
const runFlow = ref('');
const selectedRun = ref<string | null>(null);
const startingRun = ref(false);
/** 定期更新でメトリクスを取り直すための参照 */
const metricsView = ref<InstanceType<typeof MetricsView> | null>(null);
/** 同じく定期実行の一覧を取り直すための参照 */
const schedulesView = ref<InstanceType<typeof SchedulesView> | null>(null);
/** 同じく流量の一覧を取り直すための参照 */
const bindingsView = ref<InstanceType<typeof BindingsView> | null>(null);

/** 選んだ対象だけをクエリに含める, 対象の切り替えで前の条件は残らない */
const searchParam = () => (search.value ? { [searchField.value]: search.value } : {});

/**
 * 検索語の確定
 * ジョブIDの形式なら詳細を直接開く, 障害の調査はIDから入ることが多い
 */
function commitSearch(value: string) {
	search.value = value;
	if (searchField.value === 'id' && isJobId(value)) selected.value = value;
}

/**
 * 条件の世代, タブ / 抽出条件 / 頁の変更で更新
 * 遅れて届いた旧条件の応答の破棄用, 定期更新では据え置き(応答が間隔より遅いと全件破棄)
 */
let conditionGeneration = 0;
let requestSequence = 0;
let appliedSequence = 0;

/** 条件を変えた後の再読込, 変更前に発行した要求の応答は反映なし */
function reloadForConditions() {
	conditionGeneration++;
	load();
}

async function load() {
	const generation = conditionGeneration;
	const sequence = ++requestSequence;
	const requested = tab.value;
	const stale = () => generation !== conditionGeneration || sequence < appliedSequence;
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
			const [list, available] = await Promise.all([
				listRuns({
					state: state.value || undefined,
					flow: runFlow.value || undefined,
					limit: pageSize.value,
					offset: page.value * pageSize.value,
				}),
				getFlows(),
			]);
			if (stale()) return;
			appliedSequence = sequence;
			runs.value = list.runs;
			total.value = list.total;
			flows.value = available.flows;
			error.value = null;
			unauthorized.value = false;
			return;
		}

		const [list, available, definedFlows] = await Promise.all([
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
			getBindings(),
			getFlows(),
		]);
		if (stale()) return;
		appliedSequence = sequence;
		jobs.value = list.jobs;
		total.value = list.total;
		bindings.value = available.bindings;
		flows.value = definedFlows.flows;
		error.value = null;
		unauthorized.value = false;
	} catch (e) {
		if (stale()) return;
		appliedSequence = sequence;
		if (isUnauthorized(e)) {
			// HTML自体は未認証でも返り、ここで初めて認証の要否が判明
			unauthorized.value = true;
			return;
		}
		error.value = e instanceof Error ? e.message : String(e);
	}
}

/** 一覧の切替では抽出条件と頁を引き継がない */
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

/** 一覧に残っている行だけを選択として扱う, 再読込で消えた行は除外 */
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
	if (refreshMs.value > 0) timer = setInterval(load, refreshMs.value);
}

/** 間隔の変更を保存して即座に反映 */
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

/** 同一列で向きの反転, 別列なら降順から */
function sortBy(column: string) {
	if (sort.value === column) desc.value = !desc.value;
	else {
		sort.value = column;
		desc.value = true;
	}
}

/**
 * 構成にある機能だけタブを表示
 * 未設定なら501, 認証前は401になり、トークンの入力後にもう一度確認
 */
async function detectFeatures() {
	const [metrics, schedules] = await Promise.allSettled([getMetrics({ hours: 24 }), listSchedules()]);
	// 501と401以外の失敗はタブを表示した上で画面側に理由を表示
	const available = (result: PromiseSettledResult<unknown>) =>
		result.status === 'fulfilled' || (!isMetricsUnavailable(result.reason) && !isUnauthorized(result.reason));
	hasMetrics.value = available(metrics);
	hasSchedules.value = available(schedules);
}

/**
 * トークンを入れ直した後の再読込, 認証で隠れていたタブもここで戻る
 * jobs / runs以外のタブは再マウント時に自前で読み込み, 401なら再びトークン入力へ
 */
function reload() {
	unauthorized.value = false;
	// トークン入力前の要求の401で入力画面へ戻さない
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

/**
 * 画面幅に応じた列の省略
 * 横スクロール前提は狭い画面で操作しづらく、重要度の低い列から非表示
 */
const COLUMN = {
	id: 'hidden lg:table-cell',
	startedAt: 'hidden xl:table-cell',
	updatedAt: 'hidden md:table-cell',
	attempts: 'hidden sm:table-cell',
	processingTime: 'hidden xl:table-cell',
};
const HEAD = 'h-12 px-4 text-left align-middle font-medium text-muted-foreground whitespace-nowrap';

/** Viewで切り替え可能な列, BindingとStatusは行の識別に必要なため固定 */
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
		// 壊れた値では既定へ復帰, 画面が表示されない状態を回避
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

/** 画面幅の規則へViewの選択を重ねる, 適用は非表示の方向のみ */
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
					<!-- ジョブの一括操作は他のタブでは非表示, 選択が残っていても対象が見えない -->
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
								<!-- ID列を隠す幅では行の識別が不能になり、ここに含めて表示 -->
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
							<!-- IDは並べ替えの意味を持たないため非活性 -->
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
								<!-- ID列を隠す幅では行の識別が不能になり、ここに含めて表示 -->
								<span v-if="visible.id" class="block font-mono text-xs break-all text-muted-foreground lg:hidden">{{ job.id }}</span>
							</td>
							<td class="p-4 align-middle font-mono text-xs text-muted-foreground" :class="columnClass('id')">{{ job.id }}</td>
							<td class="p-4 align-middle"><StatusCell :state="job.state" /></td>
							<td class="p-4 align-middle whitespace-nowrap" :class="columnClass('startedAt')">{{ at(job.dispatched_at) }}</td>
							<td class="p-4 align-middle whitespace-nowrap" :class="columnClass('updatedAt')">{{ at(job.updated_at) }}</td>
							<td class="p-4 align-middle tabular-nums" :class="columnClass('attempts')">{{ job.attempts }} / {{ job.max_attempts }}</td>
							<td class="p-4 align-middle tabular-nums" :class="columnClass('processingTime')">{{ durationOf(job) }}</td>
							<!-- 行のクリックで詳細が開く, 操作メニューへの伝播は停止 -->
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
