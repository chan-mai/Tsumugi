<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import PageHeader from '../components/PageHeader.vue';
import { getMetrics, isUnauthorized, type Metrics } from '../api';
import LoadingState from '../components/LoadingState.vue';
import FilterMenu from '../components/FilterMenu.vue';
import { onRefresh } from '../composables/useAutoRefresh';
import { bindings, definitionsReady } from '../composables/useDefinitions';
import { useQueryChoice, useQueryText } from '../composables/useQueryState';
import { formatTimestamp } from '../time';
import { CARD, EMPTY_ROW, ERROR_TEXT, TABLE, TABLE_WRAP, TBODY, TD, TH, THEAD } from '../ui';

const WINDOWS = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30 } as const;
type Window = keyof typeof WINDOWS;

const { t } = useI18n();

const range = useQueryChoice<Window>('window', Object.keys(WINDOWS) as Window[], '24h');
const binding = useQueryText('binding');
const metrics = ref<Metrics | null>(null);
const error = ref<string | null>(null);
// 現在条件の応答待ち, 旧条件の結果表示防止
const pending = ref(true);

// 遅延した旧応答による上書き防止用の連番
let generation = 0;

async function load() {
	const requested = ++generation;
	try {
		const loaded = await getMetrics({ hours: WINDOWS[range.value], ...(binding.value ? { binding: binding.value } : {}) });
		if (requested !== generation) return;
		metrics.value = loaded;
		pending.value = false;
		error.value = null;
	} catch (e) {
		if (requested !== generation) return;
		pending.value = false;
		if (isUnauthorized(e)) return;
		error.value = e instanceof Error ? e.message : String(e);
	}
}

watch(
	[range, binding],
	() => {
		pending.value = true;
		void load();
	},
	{ immediate: true },
);
onRefresh(() => void load());

const peak = computed(() => Math.max(1, ...(metrics.value?.series ?? []).map((point) => point.total)));

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const ms = (value: number) => (value >= 1_000 ? `${(value / 1_000).toFixed(1)} s` : `${Math.round(value)} ms`);
const at = (value: number) => (Number.isFinite(value) ? formatTimestamp(value) : '');
</script>

<template>
	<PageHeader />
	<div class="space-y-4">
		<div class="flex flex-wrap items-center gap-2">
			<FilterMenu
				:title="t('common.binding')"
				:options="bindings"
				:loading="!definitionsReady"
				:selected="binding"
				@select="binding = $event"
			/>
			<div class="flex items-center gap-1 rounded-lg bg-neutral-soft p-1">
				<button
					v-for="option in Object.keys(WINDOWS) as Window[]"
					:key="option"
					type="button"
					class="h-7 rounded-md border-none px-3 text-sm"
					:class="range === option ? 'bg-surface font-medium text-ink' : 'bg-transparent text-ink-muted hover:text-ink'"
					@click="range = option"
				>
					{{ option }}
				</button>
			</div>
			<span v-if="error" :class="ERROR_TEXT">{{ t('app.failedToLoad', { error }) }}</span>
		</div>

		<div :class="CARD">
			<h2 class="mb-4 text-base font-semibold">{{ t('metrics.perHour') }}</h2>
			<LoadingState v-if="pending" />
			<div v-else-if="metrics && metrics.series.length > 0" class="flex h-32 items-end gap-px">
				<div
					v-for="point in metrics.series"
					:key="point.at"
					class="flex flex-1 flex-col justify-start overflow-hidden rounded-t-sm bg-accent-soft"
					:style="{ height: `${(point.total / peak) * 100}%` }"
					:title="t('metrics.bar', { at: at(point.at), total: point.total, failed: point.failed })"
				>
					<div class="w-full bg-critical" :style="{ height: `${(point.failed / Math.max(1, point.total)) * 100}%` }" />
				</div>
			</div>
			<p v-else class="text-sm text-ink-subtle">{{ t('metrics.noData') }}</p>
		</div>

		<div :class="TABLE_WRAP">
			<LoadingState v-if="pending" />
			<table v-else :class="TABLE">
				<thead :class="THEAD">
					<tr>
						<th :class="TH">{{ t('common.binding') }}</th>
						<th :class="TH">{{ t('metrics.total') }}</th>
						<th :class="TH">{{ t('metrics.failed') }}</th>
						<th :class="TH">{{ t('metrics.failureRate') }}</th>
						<th :class="TH">{{ t('metrics.avgDuration') }}</th>
						<th :class="TH">{{ t('metrics.p95Duration') }}</th>
						<th :class="TH">{{ t('metrics.maxDuration') }}</th>
						<th :class="TH">{{ t('metrics.avgAttempts') }}</th>
					</tr>
				</thead>
				<tbody :class="TBODY">
					<tr v-for="row in metrics?.bindings ?? []" :key="row.binding">
						<td :class="TD" class="font-medium whitespace-nowrap">{{ row.binding }}</td>
						<td :class="TD" class="text-ink-muted tabular-nums">{{ row.total }}</td>
						<td :class="TD" class="text-ink-muted tabular-nums">{{ row.failed }}</td>
						<td :class="[TD, row.failureRate > 0 ? 'text-critical' : 'text-ink-muted']" class="tabular-nums">
							{{ percent(row.failureRate) }}
						</td>
						<td :class="TD" class="text-ink-muted tabular-nums">{{ ms(row.avgDurationMs) }}</td>
						<td :class="TD" class="text-ink-muted tabular-nums">{{ ms(row.p95DurationMs) }}</td>
						<td :class="TD" class="text-ink-muted tabular-nums">{{ ms(row.maxDurationMs) }}</td>
						<td :class="TD" class="text-ink-muted tabular-nums">{{ row.avgAttempts.toFixed(2) }}</td>
					</tr>
					<tr v-if="(metrics?.bindings ?? []).length === 0">
						<td colspan="8" :class="EMPTY_ROW">{{ t('common.noResults') }}</td>
					</tr>
				</tbody>
			</table>
		</div>
	</div>
</template>
