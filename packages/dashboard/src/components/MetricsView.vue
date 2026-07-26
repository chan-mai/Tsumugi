<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import FilterMenu from './FilterMenu.vue';
import { getMetrics, isUnauthorized, type Metrics } from '../api';

const WINDOWS = [
	{ hours: 24, label: '24h' },
	{ hours: 24 * 7, label: '7d' },
	{ hours: 24 * 30, label: '30d' },
];

const props = defineProps<{ bindings: string[] }>();
const emit = defineEmits<{ unauthorized: [] }>();

const hours = ref(24);
const binding = ref('');
const metrics = ref<Metrics | null>(null);
const error = ref<string | null>(null);

async function load() {
	try {
		metrics.value = await getMetrics({ hours: hours.value, ...(binding.value ? { binding: binding.value } : {}) });
		error.value = null;
	} catch (e) {
		if (isUnauthorized(e)) {
			emit('unauthorized');
			return;
		}
		error.value = e instanceof Error ? e.message : String(e);
	}
}

watch([hours, binding], load, { immediate: true });
defineExpose({ load });

/** 棒の高さは区間内の最大件数で割る */
const peak = computed(() => Math.max(1, ...(metrics.value?.series ?? []).map((point) => point.total)));

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const ms = (value: number) => (value >= 1_000 ? `${(value / 1_000).toFixed(1)} s` : `${Math.round(value)} ms`);
const at = (value: number) => (Number.isFinite(value) ? new Date(value).toLocaleString() : '');

const HEAD = 'h-12 px-4 text-left align-middle font-medium text-muted-foreground whitespace-nowrap';
</script>

<template>
	<div class="space-y-4">
		<div class="flex flex-wrap items-center gap-2">
			<FilterMenu title="Binding" :options="props.bindings" :selected="binding" @select="binding = $event" />
			<div class="flex items-center gap-1">
				<button
					v-for="option in WINDOWS"
					:key="option.hours"
					type="button"
					class="h-8 rounded-card border-none px-3 text-sm"
					:class="hours === option.hours ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent'"
					@click="hours = option.hours"
				>
					{{ option.label }}
				</button>
			</div>
			<span v-if="error" class="text-sm text-destructive">Failed to load: {{ error }}</span>
		</div>

		<div class="rounded-card border border-border p-4">
			<p class="mb-3 text-sm text-muted-foreground">Terminal jobs per hour</p>
			<div v-if="metrics && metrics.series.length > 0" class="flex h-32 items-end gap-px">
				<div
					v-for="point in metrics.series"
					:key="point.at"
					class="flex-1 bg-accent"
					:style="{ height: `${(point.total / peak) * 100}%` }"
					:title="`${at(point.at)} / ${point.total} jobs / ${point.failed} failed`"
				>
					<div class="w-full bg-destructive" :style="{ height: `${(point.failed / Math.max(1, point.total)) * 100}%` }" />
				</div>
			</div>
			<p v-else class="text-sm text-muted-foreground">No data.</p>
		</div>

		<div class="relative w-full overflow-x-auto rounded-card border border-border">
			<table class="w-full caption-bottom text-sm">
				<thead class="[&_tr]:border-b [&_tr]:border-border">
					<tr>
						<th :class="HEAD">Binding</th>
						<th :class="HEAD">Total</th>
						<th :class="HEAD">Failed</th>
						<th :class="HEAD">Failure rate</th>
						<th :class="HEAD">Avg duration</th>
						<th :class="HEAD">p95 duration</th>
						<th :class="HEAD">Max duration</th>
						<th :class="HEAD">Avg attempts</th>
					</tr>
				</thead>
				<tbody class="[&_tr:last-child]:border-0">
					<tr v-for="row in metrics?.bindings ?? []" :key="row.binding" class="border-b border-border">
						<td class="p-4 align-middle">{{ row.binding }}</td>
						<td class="p-4 align-middle tabular-nums">{{ row.total }}</td>
						<td class="p-4 align-middle tabular-nums">{{ row.failed }}</td>
						<td class="p-4 align-middle tabular-nums" :class="row.failureRate > 0 ? 'text-destructive' : ''">
							{{ percent(row.failureRate) }}
						</td>
						<td class="p-4 align-middle tabular-nums">{{ ms(row.avgDurationMs) }}</td>
						<td class="p-4 align-middle tabular-nums">{{ ms(row.p95DurationMs) }}</td>
						<td class="p-4 align-middle tabular-nums">{{ ms(row.maxDurationMs) }}</td>
						<td class="p-4 align-middle tabular-nums">{{ row.avgAttempts.toFixed(2) }}</td>
					</tr>
					<tr v-if="(metrics?.bindings ?? []).length === 0">
						<td colspan="8" class="h-24 text-center text-muted-foreground">No results.</td>
					</tr>
				</tbody>
			</table>
		</div>
	</div>
</template>
