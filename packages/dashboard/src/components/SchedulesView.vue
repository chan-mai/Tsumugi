<script setup lang="ts">
import { ref } from 'vue';
import { isUnauthorized, listSchedules, setSchedulePaused, triggerSchedule, type Schedule } from '../api';
import { formatTimestamp } from '../time';

const emit = defineEmits<{ unauthorized: []; job: [string]; run: [string] }>();

const schedules = ref<Schedule[]>([]);
const error = ref<string | null>(null);
const message = ref<string | null>(null);
/** 操作中のスケジュール, 二度押しを防ぐ */
const busy = ref<string | null>(null);

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

async function act(name: string, run: () => Promise<string>) {
	busy.value = name;
	try {
		message.value = `${name}: ${await run()}`;
	} catch (e) {
		if (isUnauthorized(e)) {
			emit('unauthorized');
			return;
		}
		message.value = e instanceof Error ? e.message : String(e);
	} finally {
		busy.value = null;
		await load();
	}
}

const setPaused = (row: Schedule, paused: boolean) =>
	act(row.name, async () => {
		await setSchedulePaused(row.name, paused);
		return paused ? 'paused' : 'resumed';
	});

const trigger = (row: Schedule) =>
	act(row.name, async () => {
		const fired = await triggerSchedule(row.name);
		return `fired ${fired.id}`;
	});

/** Trigger押下後の確認待ちの行 */
const confirming = ref<Schedule | null>(null);

function runTrigger(row: Schedule) {
	confirming.value = null;
	return trigger(row);
}

const interval = (row: Schedule) => (row.cron !== null ? row.cron : `every ${duration(row.every_ms ?? 0)}`);

/** 間隔は桁の大きい単位から, ミリ秒のままでは判読不能 */
function duration(ms: number): string {
	if (ms >= 3_600_000) return `${+(ms / 3_600_000).toFixed(1)}h`;
	if (ms >= 60_000) return `${+(ms / 60_000).toFixed(1)}m`;
	return `${+(ms / 1_000).toFixed(1)}s`;
}

const at = (value: number | null, timeZone: string) => (value === null ? '' : formatTimestamp(value, timeZone));

/** 予定と実際の差, 遅れの観測に使う */
const delay = (row: Schedule) =>
	row.last_run_at === null || row.last_fired_at === null || row.last_fired_at <= row.last_run_at
		? ''
		: `+${duration(row.last_fired_at - row.last_run_at)}`;

const HEAD = 'h-12 px-4 text-left align-middle font-medium text-muted-foreground whitespace-nowrap';
const LINK = 'block border-none p-0 font-mono text-xs break-all underline underline-offset-2 hover:text-foreground';
const BTN = 'h-8 rounded-card border border-border px-3 text-sm hover:bg-accent disabled:opacity-50';
</script>

<template>
	<div class="space-y-4">
		<div class="flex flex-wrap items-center gap-2">
			<span v-if="message" class="text-sm text-muted-foreground">{{ message }}</span>
			<span v-if="error" class="text-sm text-destructive">Failed to load: {{ error }}</span>
		</div>

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
						<th :class="HEAD">Actions</th>
					</tr>
				</thead>
				<tbody class="[&_tr:last-child]:border-0">
					<tr v-for="row in schedules" :key="row.name" class="border-b border-border">
						<td class="p-4 align-middle">
							{{ row.name }}
							<span v-if="row.paused" class="ml-2 rounded-card bg-accent px-2 py-0.5 text-xs">paused</span>
							<p v-if="row.last_error" class="text-xs text-destructive">{{ row.last_error }}</p>
						</td>
						<td class="p-4 align-middle">
							<span class="text-muted-foreground">{{ row.kind }}</span>
							{{ row.target }}
						</td>
						<td class="p-4 align-middle tabular-nums">{{ interval(row) }}</td>
						<td class="p-4 align-middle text-muted-foreground">{{ row.overlap }}</td>
						<!-- 停止中の予定時刻は表示なし, 再開時に再計算 -->
						<td class="p-4 align-middle tabular-nums">{{ row.paused ? '-' : at(row.next_run_at, row.time_zone) }}</td>
						<td class="p-4 align-middle tabular-nums">
							{{ at(row.last_run_at, row.time_zone) }}
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
							<span v-if="row.last_skipped_at !== null" class="text-xs text-muted-foreground">{{
								at(row.last_skipped_at, row.time_zone)
							}}</span>
						</td>
						<td class="p-4 align-middle">
							<div class="flex items-center gap-1">
								<button type="button" :class="BTN" :disabled="busy === row.name" @click="setPaused(row, !row.paused)">
									{{ row.paused ? 'Resume' : 'Pause' }}
								</button>
								<button type="button" :class="BTN" :disabled="busy === row.name" @click="confirming = row">Trigger</button>
							</div>
						</td>
					</tr>
					<tr v-if="schedules.length === 0">
						<td colspan="8" class="h-24 text-center text-muted-foreground">No schedules.</td>
					</tr>
				</tbody>
			</table>
		</div>

		<!-- 即時発火の確認 -->
		<div v-if="confirming" class="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4" @click.self="confirming = null">
			<div class="w-full max-w-md rounded-card border border-border bg-background p-4 shadow-md">
				<h2 class="text-base font-medium">Trigger {{ confirming.name }}</h2>
				<p class="mt-2 text-sm text-muted-foreground">
					Fires {{ confirming.kind === 'job' ? 'a job for' : 'a run of' }} {{ confirming.target }} once, now.
				</p>
				<p class="mt-1 text-sm text-muted-foreground">The next scheduled run does not change.</p>
				<div class="mt-4 flex justify-end gap-2">
					<button
						type="button"
						class="h-8 rounded-card border-none bg-accent px-3 text-sm text-muted-foreground hover:bg-border"
						@click="confirming = null"
					>
						Cancel
					</button>
					<button
						type="button"
						class="h-8 rounded-card border-none bg-primary px-3 text-sm text-primary-foreground"
						@click="runTrigger(confirming)"
					>
						Trigger
					</button>
				</div>
			</div>
		</div>
	</div>
</template>
