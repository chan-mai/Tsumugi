<script setup lang="ts">
import { ref } from 'vue';
import { isUnauthorized, listSchedules, type Schedule } from '../api';

const emit = defineEmits<{ unauthorized: []; job: [string]; run: [string] }>();

const schedules = ref<Schedule[]>([]);
const error = ref<string | null>(null);

/** 遅れて届いた古い応答で最新の結果を上書きしないための連番 */
let generation = 0;

async function load() {
	const requested = ++generation;
	try {
		const loaded = await listSchedules();
		if (requested !== generation) return;
		schedules.value = loaded;
		error.value = null;
	} catch (e) {
		if (requested !== generation) return;
		if (isUnauthorized(e)) {
			emit('unauthorized');
			return;
		}
		error.value = e instanceof Error ? e.message : String(e);
	}
}

void load();
defineExpose({ load });

const interval = (row: Schedule) => (row.cron !== null ? row.cron : `every ${duration(row.every_ms ?? 0)}`);

/** 間隔は桁の大きい単位から, ミリ秒のままでは読めない */
function duration(ms: number): string {
	if (ms >= 3_600_000) return `${+(ms / 3_600_000).toFixed(1)}h`;
	if (ms >= 60_000) return `${+(ms / 60_000).toFixed(1)}m`;
	return `${+(ms / 1_000).toFixed(1)}s`;
}

const at = (value: number | null) => (value === null ? '' : new Date(value).toLocaleString());

/** 予定と実際の差, 遅れの観測に使う */
const delay = (row: Schedule) =>
	row.last_run_at === null || row.last_fired_at === null || row.last_fired_at <= row.last_run_at
		? ''
		: `+${duration(row.last_fired_at - row.last_run_at)}`;

const HEAD = 'h-12 px-4 text-left align-middle font-medium text-muted-foreground whitespace-nowrap';
const LINK = 'block border-none p-0 font-mono text-xs break-all underline underline-offset-2 hover:text-foreground';
</script>

<template>
	<div class="space-y-4">
		<p v-if="error" class="text-sm text-destructive">Failed to load: {{ error }}</p>

		<div class="relative w-full overflow-x-auto rounded-card border border-border">
			<table class="w-full caption-bottom text-sm">
				<thead class="[&_tr]:border-b [&_tr]:border-border">
					<tr>
						<th :class="HEAD">Name</th>
						<th :class="HEAD">Target</th>
						<th :class="HEAD">Interval</th>
						<th :class="HEAD">Overlap</th>
						<th :class="HEAD">Next run</th>
						<th :class="HEAD">Last run</th>
						<th :class="HEAD">Skipped</th>
					</tr>
				</thead>
				<tbody class="[&_tr:last-child]:border-0">
					<tr v-for="row in schedules" :key="row.name" class="border-b border-border">
						<td class="p-4 align-middle">
							{{ row.name }}
							<p v-if="row.last_error" class="text-xs text-destructive">{{ row.last_error }}</p>
						</td>
						<td class="p-4 align-middle">
							<span class="text-muted-foreground">{{ row.kind }}</span>
							{{ row.target }}
						</td>
						<td class="p-4 align-middle tabular-nums">{{ interval(row) }}</td>
						<td class="p-4 align-middle text-muted-foreground">{{ row.overlap }}</td>
						<td class="p-4 align-middle tabular-nums">{{ at(row.next_run_at) }}</td>
						<td class="p-4 align-middle tabular-nums">
							{{ at(row.last_run_at) }}
							<span v-if="delay(row)" class="text-xs text-muted-foreground">{{ delay(row) }}</span>
							<button v-if="row.last_job_id" type="button" :class="LINK" @click="emit('job', row.last_job_id)">
								{{ row.last_job_id }}
							</button>
							<button v-else-if="row.last_run_id" type="button" :class="LINK" @click="emit('run', row.last_run_id)">
								{{ row.last_run_id }}
							</button>
						</td>
						<td class="p-4 align-middle tabular-nums">
							{{ row.skipped_count }}
							<span v-if="row.last_skipped_at" class="text-xs text-muted-foreground">{{ at(row.last_skipped_at) }}</span>
						</td>
					</tr>
					<tr v-if="schedules.length === 0">
						<td colspan="7" class="h-24 text-center text-muted-foreground">No schedules.</td>
					</tr>
				</tbody>
			</table>
		</div>
	</div>
</template>
