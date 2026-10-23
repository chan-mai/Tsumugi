<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Job } from '../api';
import { at, columnClass, visible } from '../columns';
import LoadingState from './LoadingState.vue';
import { EMPTY_ROW, TABLE, TABLE_WRAP, TBODY, TD, TH, THEAD } from '../ui';
import CheckBox from './CheckBox.vue';
import RowActions from './RowActions.vue';
import SortHeader from './SortHeader.vue';
import StatusCell from './StatusCell.vue';

const props = defineProps<{ jobs: Job[]; picked: string[]; sort: string; desc: boolean; loading: boolean }>();
const emit = defineEmits<{
	select: [id: string];
	sort: [column: string];
	changed: [];
	message: [text: string];
	'update:picked': [ids: string[]];
}>();
const { t } = useI18n();

const allPicked = computed(() => props.jobs.length > 0 && props.jobs.every((job) => props.picked.includes(job.id)));

function togglePick(id: string) {
	emit('update:picked', props.picked.includes(id) ? props.picked.filter((value) => value !== id) : [...props.picked, id]);
}

function toggleAll() {
	emit('update:picked', allPicked.value ? [] : props.jobs.map((job) => job.id));
}

const durationOf = (job: Job) =>
	job.dispatched_at && job.updated_at > job.dispatched_at ? `${job.updated_at - job.dispatched_at} ms` : '';
</script>

<template>
	<div :class="TABLE_WRAP">
		<LoadingState v-if="loading" />
		<table v-else :class="TABLE">
			<thead :class="THEAD">
				<tr>
					<th class="h-11 w-10 pl-4">
						<button
							type="button"
							class="flex size-6 items-center justify-center rounded border-none bg-transparent"
							:aria-label="t('jobs.selectAll')"
							@click="toggleAll"
						>
							<CheckBox :checked="allPicked" />
						</button>
					</th>
					<th :class="TH">
						<SortHeader :label="t('common.binding')" column="binding" :sort="sort" :desc="desc" @sort="emit('sort', $event)" />
					</th>
					<th :class="[TH, columnClass('id')]">{{ t('columns.id') }}</th>
					<th :class="TH">
						<SortHeader :label="t('common.status')" column="state" :sort="sort" :desc="desc" @sort="emit('sort', $event)" />
					</th>
					<th :class="[TH, columnClass('startedAt')]">{{ t('columns.startedAt') }}</th>
					<th :class="[TH, columnClass('updatedAt')]">
						<SortHeader :label="t('columns.updatedAt')" column="updated_at" :sort="sort" :desc="desc" @sort="emit('sort', $event)" />
					</th>
					<th :class="[TH, columnClass('attempts')]">
						<SortHeader :label="t('columns.attempts')" column="attempts" :sort="sort" :desc="desc" @sort="emit('sort', $event)" />
					</th>
					<th :class="[TH, columnClass('processingTime')]">{{ t('columns.processingTime') }}</th>
					<th class="h-11 w-12 px-4" />
				</tr>
			</thead>
			<tbody :class="TBODY">
				<tr
					v-for="job in jobs"
					:key="job.id"
					class="cursor-pointer transition-colors hover:bg-neutral-soft"
					@click="emit('select', job.id)"
				>
					<td class="pl-4 align-middle" @click.stop>
						<button
							type="button"
							class="flex size-6 items-center justify-center rounded border-none bg-transparent"
							:aria-label="t('jobs.selectRow', { id: job.id })"
							@click="togglePick(job.id)"
						>
							<CheckBox :checked="props.picked.includes(job.id)" />
						</button>
					</td>
					<td :class="TD" class="font-medium whitespace-nowrap">
						{{ job.binding }}
						<!-- ID列非表示の幅での行識別用 -->
						<span v-if="visible.id" class="block font-mono text-xs font-normal whitespace-normal break-all text-ink-subtle lg:hidden">{{ job.id }}</span>
					</td>
					<td :class="[TD, columnClass('id')]" class="font-mono text-xs whitespace-nowrap text-ink-muted">{{ job.id }}</td>
					<td :class="TD"><StatusCell :state="job.state" /></td>
					<td :class="[TD, columnClass('startedAt')]" class="whitespace-nowrap text-ink-muted">{{ at(job.dispatched_at) }}</td>
					<td :class="[TD, columnClass('updatedAt')]" class="whitespace-nowrap text-ink-muted">{{ at(job.updated_at) }}</td>
					<td :class="[TD, columnClass('attempts')]" class="text-ink-muted tabular-nums">{{ job.attempts }} / {{ job.max_attempts }}</td>
					<td :class="[TD, columnClass('processingTime')]" class="whitespace-nowrap text-ink-muted tabular-nums">{{ durationOf(job) }}</td>
					<td :class="TD" @click.stop>
						<RowActions
							:job-id="job.id"
							:state="job.state"
							:retryable="job.retryable"
							@changed="emit('changed')"
							@message="emit('message', $event)"
						/>
					</td>
				</tr>
				<tr v-if="jobs.length === 0">
					<td colspan="9" :class="EMPTY_ROW">{{ t('common.noResults') }}</td>
				</tr>
			</tbody>
		</table>
	</div>
</template>
