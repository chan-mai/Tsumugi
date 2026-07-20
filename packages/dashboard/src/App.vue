<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import FilterMenu from './components/FilterMenu.vue';
import JobDetailModal from './components/JobDetailModal.vue';
import NewJobModal from './components/NewJobModal.vue';
import Pagination from './components/Pagination.vue';
import RowActions from './components/RowActions.vue';
import StatusCell from './components/StatusCell.vue';
import TokenPrompt from './components/TokenPrompt.vue';
import { getBindings, getStats, isUnauthorized, listJobs, tokenCookie, type Job } from './api';

const STATES = ['SCHEDULED', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'STALLED'];

const jobs = ref<Job[]>([]);
const total = ref(0);
const byState = ref<Record<string, number>>({});
const bindings = ref<string[]>([]);
const state = ref('');
const binding = ref('');
const page = ref(0);
const pageSize = ref(20);
const selected = ref<string | null>(null);
const creating = ref(false);
const message = ref<string | null>(null);
const error = ref<string | null>(null);
const unauthorized = ref(false);
const autoRefresh = ref(true);
const canPromptToken = tokenCookie() !== null;
let timer: ReturnType<typeof setInterval> | undefined;

async function load() {
	try {
		const [list, stats, available] = await Promise.all([
			listJobs({
				state: state.value || undefined,
				binding: binding.value || undefined,
				limit: pageSize.value,
				offset: page.value * pageSize.value,
			}),
			getStats(),
			getBindings(),
		]);
		jobs.value = list.jobs;
		total.value = list.total;
		byState.value = stats.byState;
		bindings.value = available.bindings;
		error.value = null;
		unauthorized.value = false;
	} catch (e) {
		if (isUnauthorized(e)) {
			// HTMLの殻は未認証でも返るので,ここで初めて認証の要否が分かる
			unauthorized.value = true;
			return;
		}
		error.value = e instanceof Error ? e.message : String(e);
	}
}

function restartTimer() {
	if (timer) clearInterval(timer);
	// 投影は数秒遅れる読み取りモデルなので短い間隔にしても意味がない
	if (autoRefresh.value) timer = setInterval(load, 3_000);
}

watch([state, binding, pageSize], () => {
	page.value = 0;
	load();
});
watch(page, load);

onMounted(() => {
	load();
	restartTimer();
});
onUnmounted(() => timer && clearInterval(timer));

const at = (value: number | null) => (value ? new Date(value).toLocaleString() : '');
const durationOf = (job: Job) =>
	job.dispatched_at && job.updated_at > job.dispatched_at ? `${job.updated_at - job.dispatched_at} ms` : '';

/**
 * 画面幅に応じて列を落とす
 * 横スクロールに頼ると狭い画面で操作しづらいので, 重要度の低い列から隠す
 */
const COLUMN = {
	id: 'hidden lg:table-cell',
	startedAt: 'hidden xl:table-cell',
	updatedAt: 'hidden md:table-cell',
	attempts: 'hidden sm:table-cell',
	processingTime: 'hidden xl:table-cell',
};
const HEAD = 'h-12 px-4 text-left align-middle font-medium text-muted-foreground whitespace-nowrap';
</script>

<template>
	<TokenPrompt v-if="unauthorized && canPromptToken" @saved="load" />

	<div v-else-if="unauthorized" class="mx-auto mt-24 max-w-sm px-4 text-center">
		<h1 class="mb-2 text-xl font-bold">Tsumugi</h1>
		<p class="text-sm text-muted-foreground">Not authorized. Sign in through your identity provider and reload.</p>
	</div>

	<div v-else class="p-4 sm:p-8">
		<header class="mb-6">
			<h1 class="text-xl font-bold">Tsumugi</h1>
		</header>

		<div class="space-y-4">
			<div class="flex flex-wrap items-center justify-between gap-2">
				<div class="flex flex-wrap items-center gap-2">
					<FilterMenu title="Binding" :options="bindings" :selected="binding" @select="binding = $event" />
					<FilterMenu title="Status" :options="STATES" :selected="state" @select="state = $event" />
					<button
						v-if="state || binding"
						type="button"
						class="h-8 rounded-card border-none px-2 text-sm text-muted-foreground hover:bg-accent"
						@click="
							state = '';
							binding = '';
						"
					>
						Reset
					</button>
				</div>

				<div class="flex items-center gap-2">
					<span v-if="message" class="text-sm text-muted-foreground">{{ message }}</span>
					<span v-if="error" class="text-sm text-destructive">Failed to load: {{ error }}</span>
					<button
						type="button"
						class="flex h-8 items-center gap-2 rounded-card border border-border bg-background px-3 text-sm hover:bg-accent"
						@click="
							autoRefresh = !autoRefresh;
							restartTimer();
						"
					>
						<span class="size-2 rounded-full" :class="autoRefresh ? 'animate-pulse bg-green-500' : 'bg-gray-300'" aria-hidden="true" />
						{{ autoRefresh ? 'Live' : 'Paused' }}
					</button>
					<button
						type="button"
						class="flex h-8 items-center gap-1.5 rounded-card border-none bg-primary px-3 text-sm text-primary-foreground"
						@click="creating = true"
					>
						<svg viewBox="0 0 16 16" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
							<path d="M8 3.5v9M3.5 8h9" />
						</svg>
						Job
					</button>
				</div>
			</div>

			<div class="relative w-full overflow-x-auto rounded-card border border-border">
				<table class="w-full caption-bottom text-sm">
					<thead class="[&_tr]:border-b [&_tr]:border-border">
						<tr>
							<th :class="HEAD">Binding</th>
							<th :class="[HEAD, COLUMN.id]">ID</th>
							<th :class="HEAD">Status</th>
							<th :class="[HEAD, COLUMN.startedAt]">Started at</th>
							<th :class="[HEAD, COLUMN.updatedAt]">Updated at</th>
							<th :class="[HEAD, COLUMN.attempts]">Attempts</th>
							<th :class="[HEAD, COLUMN.processingTime]">Processing time</th>
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
							<td class="p-4 align-middle">
								{{ job.binding }}
								<!-- ID列を隠す幅では行の識別ができなくなるので, ここに畳んで出す -->
								<span class="block font-mono text-xs break-all text-muted-foreground lg:hidden">{{ job.id }}</span>
							</td>
							<td class="p-4 align-middle font-mono text-xs text-muted-foreground" :class="COLUMN.id">{{ job.id }}</td>
							<td class="p-4 align-middle"><StatusCell :state="job.state" /></td>
							<td class="p-4 align-middle whitespace-nowrap" :class="COLUMN.startedAt">{{ at(job.dispatched_at) }}</td>
							<td class="p-4 align-middle whitespace-nowrap" :class="COLUMN.updatedAt">{{ at(job.updated_at) }}</td>
							<td class="p-4 align-middle tabular-nums" :class="COLUMN.attempts">{{ job.attempts }} / {{ job.max_attempts }}</td>
							<td class="p-4 align-middle tabular-nums" :class="COLUMN.processingTime">{{ durationOf(job) }}</td>
							<!-- 行のクリックで詳細が開くので, 操作メニューまで伝播させない -->
							<td class="p-4 align-middle" @click.stop>
								<RowActions :job-id="job.id" :state="job.state" @changed="load" @message="message = $event" />
							</td>
						</tr>
						<tr v-if="jobs.length === 0">
							<td colspan="8" class="h-24 text-center text-muted-foreground">No results.</td>
						</tr>
					</tbody>
				</table>
			</div>

			<Pagination v-model:page="page" v-model:page-size="pageSize" :total="total" />
		</div>

		<JobDetailModal :job-id="selected" @close="selected = null" />
		<NewJobModal
			:open="creating"
			:bindings="bindings"
			@close="creating = false"
			@created="
				message = 'Job created';
				load();
			"
		/>
	</div>
</template>
