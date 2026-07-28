<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import BulkActions from './components/BulkActions.vue';
import CheckBox from './components/CheckBox.vue';
import FilterMenu from './components/FilterMenu.vue';
import JobDetailModal from './components/JobDetailModal.vue';
import MetricsView from './components/MetricsView.vue';
import NewJobModal from './components/NewJobModal.vue';
import NewRunModal from './components/NewRunModal.vue';
import Pagination from './components/Pagination.vue';
import RefreshMenu from './components/RefreshMenu.vue';
import RowActions from './components/RowActions.vue';
import RunDetailModal from './components/RunDetailModal.vue';
import SortHeader from './components/SortHeader.vue';
import StatusCell from './components/StatusCell.vue';
import TokenPrompt from './components/TokenPrompt.vue';
import ViewMenu from './components/ViewMenu.vue';
import {
	getBindings,
	getFlows,
	getMetrics,
	getStats,
	isMetricsUnavailable,
	isUnauthorized,
	listJobs,
	listRuns,
	tokenCookie,
	type Job,
	type Run,
} from './api';
import { loadRefresh, REFRESH_KEY } from './refresh';

const STATES = ['SCHEDULED', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'STALLED'];
/** runが取る4つ(ADR-0029) */
const RUN_STATES = ['RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'];

const jobs = ref<Job[]>([]);
const total = ref(0);
const byState = ref<Record<string, number>>({});
const bindings = ref<string[]>([]);
const state = ref('');
const binding = ref('');
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

/** flowsを設定していない利用者にはrunの画面自体を出さない */
const tab = ref<'jobs' | 'runs' | 'metrics'>('jobs');
/** Analytics Engineの設定がある構成でのみメトリクスのタブを出す */
const hasMetrics = ref(false);
/** 設定した機能のぶんだけタブを出す */
const tabs = computed(() => ['jobs', ...(flows.value.length > 0 ? ['runs'] : []), ...(hasMetrics.value ? ['metrics'] : [])] as const);
const flows = ref<string[]>([]);
const runs = ref<Run[]>([]);
const runFlow = ref('');
const selectedRun = ref<string | null>(null);
const startingRun = ref(false);
/** 定期更新でメトリクスを取り直すための参照 */
const metricsView = ref<InstanceType<typeof MetricsView> | null>(null);

async function load() {
	// 切替前に発行した応答で共有の状態を上書きしないよう, 開始時のタブを覚えておく
	const requested = tab.value;
	try {
		if (requested === 'metrics') {
			await metricsView.value?.load();
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
			if (tab.value !== requested) return;
			runs.value = list.runs;
			total.value = list.total;
			flows.value = available.flows;
			error.value = null;
			unauthorized.value = false;
			return;
		}

		const [list, stats, available, definedFlows] = await Promise.all([
			listJobs({
				state: state.value || undefined,
				binding: binding.value || undefined,
				sort: sort.value,
				order: desc.value ? 'desc' : 'asc',
				limit: pageSize.value,
				offset: page.value * pageSize.value,
			}),
			getStats(),
			getBindings(),
			getFlows(),
		]);
		if (tab.value !== requested) return;
		jobs.value = list.jobs;
		total.value = list.total;
		byState.value = stats.byState;
		bindings.value = available.bindings;
		flows.value = definedFlows.flows;
		error.value = null;
		unauthorized.value = false;
	} catch (e) {
		if (tab.value !== requested) return;
		if (isUnauthorized(e)) {
			// HTML自体は未認証でも返るので, ここで初めて認証の要否が分かる
			unauthorized.value = true;
			return;
		}
		error.value = e instanceof Error ? e.message : String(e);
	}
}

/** 一覧が入れ替わるので絞り込みと頁は持ち越さない */
function switchTab(next: 'jobs' | 'runs' | 'metrics') {
	if (tab.value === next) return;
	tab.value = next;
	state.value = '';
	binding.value = '';
	runFlow.value = '';
	page.value = 0;
	load();
}

const progressOf = (run: Run) => `${run.node_done} / ${run.node_total}`;

/** 一覧に残っている行だけを選択として扱う、再読込で消えた行は落とす */
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

/** 間隔の変更を保存して即座に反映する */
function setRefresh(ms: number) {
	refreshMs.value = ms;
	restartTimer();
	try {
		localStorage.setItem(REFRESH_KEY, String(ms));
	} catch {
		// プライベートモード等の書き込み不可, 選択自体は継続
	}
}

watch([state, binding, runFlow, pageSize, sort, desc], () => {
	page.value = 0;
	load();
});
watch(page, load);

/** 同一列で向きの反転,別列なら降順から */
function sortBy(column: string) {
	if (sort.value === column) desc.value = !desc.value;
	else {
		sort.value = column;
		desc.value = true;
	}
}

onMounted(async () => {
	load();
	restartTimer();
	try {
		await getMetrics({ hours: 24 });
		hasMetrics.value = true;
	} catch (e) {
		// 設定が無い場合は501, それ以外の失敗はタブを出した上で画面側に理由を出す
		hasMetrics.value = !isMetricsUnavailable(e) && !isUnauthorized(e);
	}
});
onUnmounted(() => timer && clearInterval(timer));

const at = (value: number | null) => (value ? new Date(value).toLocaleString() : '');
const durationOf = (job: Job) =>
	job.dispatched_at && job.updated_at > job.dispatched_at ? `${job.updated_at - job.dispatched_at} ms` : '';

/**
 * 画面幅に応じて列を落とす
 * 横スクロールに頼ると狭い画面で操作しづらいので,重要度の低い列から隠す
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
		// 壊れた値では既定へ復帰, 画面が表示されない状態を避ける
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
		// プライベートモード等の書き込み不可,表示自体は継続
	}
}

/** 画面幅の規則へViewの選択を重ねる,効かせるのは消す方向のみ */
const columnClass = (key: keyof typeof COLUMN) => (visible.value[key] ? COLUMN[key] : 'hidden');
</script>

<template>
	<TokenPrompt v-if="unauthorized && canPromptToken" @saved="load" />

	<div v-else-if="unauthorized" class="mx-auto mt-24 max-w-sm px-4 text-center">
		<h1 class="mb-2 text-xl font-bold">Tsumugi</h1>
		<p class="text-sm text-muted-foreground">Not authorized. Sign in through your identity provider and reload.</p>
	</div>

	<div v-else class="p-4 sm:p-8">
		<header class="mb-6 flex flex-wrap items-center gap-4">
			<h1 class="text-xl font-bold">Tsumugi</h1>
			<!-- flowsが1つも無い構成ではrunの画面を出さない -->
			<nav v-if="flows.length > 0 || hasMetrics" class="flex items-center gap-1 text-sm">
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
				<div v-if="tab !== 'metrics'" class="flex flex-wrap items-center gap-2">
					<FilterMenu v-if="tab === 'jobs'" title="Binding" :options="bindings" :selected="binding" @select="binding = $event" />
					<FilterMenu v-else title="Flow" :options="flows" :selected="runFlow" @select="runFlow = $event" />
					<FilterMenu title="Status" :options="tab === 'jobs' ? STATES : RUN_STATES" :selected="state" @select="state = $event" />
					<button
						v-if="state || binding || runFlow"
						type="button"
						class="h-8 rounded-card border-none px-2 text-sm text-muted-foreground hover:bg-accent"
						@click="
							state = '';
							binding = '';
							runFlow = '';
						"
					>
						Reset
					</button>
				</div>

				<div class="flex items-center gap-2">
					<span v-if="message" class="text-sm text-muted-foreground">{{ message }}</span>
					<span v-if="error" class="text-sm text-destructive">Failed to load: {{ error }}</span>
					<div v-if="tab === 'metrics'" class="grow" />
					<!-- 一覧向けの操作はメトリクスのタブでは出さない, 選択が残っていても対象が見えない -->
					<BulkActions
						v-if="tab !== 'metrics' && selectedIds.length > 0"
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
						v-if="tab !== 'metrics'"
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
								<!-- ID列を隠す幅では行の識別ができなくなるので,ここに含めて表示する -->
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
								<!-- ID列を隠す幅では行の識別ができなくなるので,ここに含めて表示する -->
								<span v-if="visible.id" class="block font-mono text-xs break-all text-muted-foreground lg:hidden">{{ job.id }}</span>
							</td>
							<td class="p-4 align-middle font-mono text-xs text-muted-foreground" :class="columnClass('id')">{{ job.id }}</td>
							<td class="p-4 align-middle"><StatusCell :state="job.state" /></td>
							<td class="p-4 align-middle whitespace-nowrap" :class="columnClass('startedAt')">{{ at(job.dispatched_at) }}</td>
							<td class="p-4 align-middle whitespace-nowrap" :class="columnClass('updatedAt')">{{ at(job.updated_at) }}</td>
							<td class="p-4 align-middle tabular-nums" :class="columnClass('attempts')">{{ job.attempts }} / {{ job.max_attempts }}</td>
							<td class="p-4 align-middle tabular-nums" :class="columnClass('processingTime')">{{ durationOf(job) }}</td>
							<!-- 行のクリックで詳細が開くので,操作メニューまで伝播させない -->
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

			<Pagination v-if="tab !== 'metrics'" v-model:page="page" v-model:page-size="pageSize" :total="total" :unit="tab" />
		</div>

		<JobDetailModal :job-id="selected" @close="selected = null" @changed="load" />
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
