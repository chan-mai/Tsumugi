<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import PageHeader from '../components/PageHeader.vue';
import { onRefresh } from '../composables/useAutoRefresh';
import { useDetail } from '../composables/useDetail';
import { isUnauthorized, listSchedules, setSchedulePaused, triggerSchedule, type Schedule } from '../api';
import { formatTimestamp } from '../time';
import { button, EMPTY_ROW, ERROR_TEXT, LINK, MUTED_TEXT, TABLE, TABLE_WRAP, TBODY, TD, TH, THEAD } from '../ui';
import LoadingState from '../components/LoadingState.vue';
import { confirmAction } from '../composables/useConfirm';

const { openJob, openRun } = useDetail();
const { t } = useI18n();

const schedules = ref<Schedule[]>([]);
const error = ref<string | null>(null);
const message = ref<string | null>(null);
const busy = ref<string | null>(null);
// 初回取得完了の有無, 取得前の空一覧表示防止
const loaded = ref(false);

// 遅延した旧応答による上書き防止用の連番
let generation = 0;

async function load() {
	const requested = ++generation;
	try {
		const result = await listSchedules();
		if (requested !== generation) return;
		schedules.value = result;
		loaded.value = true;
		error.value = null;
	} catch (e) {
		if (requested !== generation) return;
		loaded.value = true;
		if (isUnauthorized(e)) return;
		error.value = e instanceof Error ? e.message : String(e);
	}
}

void load();
onRefresh(() => void load());

async function act(name: string, run: () => Promise<string>) {
	busy.value = name;
	try {
		message.value = `${name}: ${await run()}`;
	} catch (e) {
		if (isUnauthorized(e)) {
			busy.value = null;
			return;
		}
		message.value = e instanceof Error ? e.message : String(e);
	}
	busy.value = null;
	await load();
}

async function setPaused(row: Schedule, paused: boolean) {
	const confirmed = await confirmAction({
		title: t(paused ? 'confirm.pause' : 'confirm.resume', { name: row.name }),
		confirmLabel: t(paused ? 'common.pause' : 'common.resume'),
		danger: paused,
	});
	if (!confirmed) return;
	await act(row.name, async () => {
		await setSchedulePaused(row.name, paused);
		return paused ? t('schedules.donePaused') : t('schedules.doneResumed');
	});
}

async function trigger(row: Schedule) {
	const confirmed = await confirmAction({
		title: t('schedules.triggerTitle', { name: row.name }),
		message: row.kind === 'job' ? t('schedules.firesJob', { target: row.target }) : t('schedules.firesRun', { target: row.target }),
		confirmLabel: t('schedules.trigger'),
	});
	if (!confirmed) return;
	await act(row.name, async () => {
		const fired = await triggerSchedule(row.name);
		return t('schedules.doneFired', { id: fired.id });
	});
}

const interval = (row: Schedule) => (row.cron !== null ? row.cron : t('schedules.every', { duration: duration(row.every_ms ?? 0) }));

function duration(ms: number): string {
	if (ms >= 3_600_000) return `${+(ms / 3_600_000).toFixed(1)}h`;
	if (ms >= 60_000) return `${+(ms / 60_000).toFixed(1)}m`;
	return `${+(ms / 1_000).toFixed(1)}s`;
}

const at = (value: number | null, timeZone: string) => (value === null ? '' : formatTimestamp(value, timeZone));

const delay = (row: Schedule) =>
	row.last_occurrence_at === null || row.last_fired_at === null || row.last_fired_at <= row.last_occurrence_at
		? ''
		: `+${duration(row.last_fired_at - row.last_occurrence_at)}`;
</script>

<template>
	<PageHeader />
	<div class="space-y-4">
		<div v-if="message || error" class="flex flex-wrap items-center gap-2">
			<span v-if="message" :class="MUTED_TEXT">{{ message }}</span>
			<span v-if="error" :class="ERROR_TEXT">{{ t('app.failedToLoad', { error }) }}</span>
		</div>

		<div :class="TABLE_WRAP">
			<LoadingState v-if="!loaded" />
			<table v-else :class="TABLE">
				<thead :class="THEAD">
					<tr>
						<th :class="TH">{{ t('schedules.name') }}</th>
						<th :class="TH">{{ t('schedules.target') }}</th>
						<th :class="TH">{{ t('schedules.interval') }}</th>
						<th :class="TH">{{ t('schedules.overlap') }}</th>
						<th :class="TH">{{ t('schedules.nextRun') }}</th>
						<th :class="TH">{{ t('schedules.lastRun') }}</th>
						<th :class="TH">{{ t('schedules.skipped') }}</th>
						<th :class="TH" />
					</tr>
				</thead>
				<tbody :class="TBODY">
					<tr v-for="row in schedules" :key="row.name">
						<td :class="TD" class="font-medium whitespace-nowrap">
							{{ row.name }}
							<span v-if="row.paused" class="ml-2 rounded-full bg-neutral-soft px-2 py-0.5 text-xs font-medium text-ink-muted">{{
								t('common.paused')
							}}</span>
							<p v-if="row.last_error" class="text-xs font-normal whitespace-normal text-critical">{{ row.last_error }}</p>
						</td>
						<td :class="TD">
							<span class="text-ink-subtle">{{ row.kind }}</span>
							{{ row.target }}
						</td>
						<td :class="TD" class="text-ink-muted tabular-nums">{{ interval(row) }}</td>
						<td :class="TD" class="text-ink-muted">{{ row.overlap }}</td>
						<!-- 停止中の予定時刻は再開時に再計算 -->
						<td :class="TD" class="min-w-48 whitespace-normal text-ink-muted tabular-nums">
							{{ row.paused ? '-' : at(row.next_occurrence_at, row.time_zone) }}
						</td>
						<td :class="TD" class="min-w-48 whitespace-normal text-ink-muted tabular-nums">
							{{ at(row.last_occurrence_at, row.time_zone) }}
							<span v-if="delay(row)" class="text-xs text-ink-subtle">{{ delay(row) }}</span>
							<button v-if="row.last_job_id" type="button" :class="LINK" class="block" @click="openJob(row.last_job_id)">
								{{ row.last_job_id }}
							</button>
							<button v-else-if="row.last_run_id" type="button" :class="LINK" class="block" @click="openRun(row.last_run_id)">
								{{ row.last_run_id }}
							</button>
						</td>
						<td :class="TD" class="text-ink-muted tabular-nums">
							{{ row.skipped_count }}
							<span v-if="row.last_skipped_at !== null" class="block text-xs whitespace-normal text-ink-subtle">{{
								at(row.last_skipped_at, row.time_zone)
							}}</span>
						</td>
						<td :class="TD">
							<div class="flex items-center justify-end gap-1">
								<button type="button" :class="button('ghost', 'sm')" :disabled="busy === row.name" @click="setPaused(row, !row.paused)">
									{{ row.paused ? t('common.resume') : t('common.pause') }}
								</button>
								<button type="button" :class="button('ghost', 'sm')" :disabled="busy === row.name" @click="trigger(row)">
									{{ t('schedules.trigger') }}
								</button>
							</div>
						</td>
					</tr>
					<tr v-if="schedules.length === 0">
						<td colspan="8" :class="EMPTY_ROW">{{ t('schedules.empty') }}</td>
					</tr>
				</tbody>
			</table>
		</div>
	</div>
</template>
