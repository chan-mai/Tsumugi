<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { Run } from '../api';
import { at, columnClass } from '../columns';
import LoadingState from './LoadingState.vue';
import { EMPTY_ROW, TABLE, TABLE_WRAP, TBODY, TD, TH, THEAD } from '../ui';
import StatusCell from './StatusCell.vue';

defineProps<{ runs: Run[]; loading: boolean }>();
const emit = defineEmits<{ select: [id: string] }>();
const { t } = useI18n();

const progressOf = (run: Run) => `${run.node_done} / ${run.node_total}`;
</script>

<template>
	<div :class="TABLE_WRAP">
		<LoadingState v-if="loading" />
		<table v-else :class="TABLE">
			<thead :class="THEAD">
				<tr>
					<th :class="TH">{{ t('common.flow') }}</th>
					<th :class="[TH, columnClass('id')]">{{ t('common.id') }}</th>
					<th :class="TH">{{ t('common.status') }}</th>
					<th :class="TH">{{ t('run.nodes') }}</th>
					<th :class="[TH, columnClass('updatedAt')]">{{ t('common.updatedAt') }}</th>
				</tr>
			</thead>
			<tbody :class="TBODY">
				<tr
					v-for="run in runs"
					:key="run.id"
					class="cursor-pointer transition-colors hover:bg-neutral-soft"
					@click="emit('select', run.id)"
				>
					<td :class="TD" class="font-medium whitespace-nowrap">
						{{ run.flow }}
						<!-- ID列非表示の幅での行識別用 -->
						<span class="block font-mono text-xs font-normal whitespace-normal break-all text-ink-subtle lg:hidden">{{ run.id }}</span>
					</td>
					<td :class="[TD, columnClass('id')]" class="font-mono text-xs text-ink-muted">{{ run.id }}</td>
					<td :class="TD"><StatusCell :state="run.state" /></td>
					<td :class="TD" class="text-ink-muted tabular-nums">
						{{ progressOf(run) }}
						<span v-if="run.node_failed > 0" class="text-critical">({{ run.node_failed }})</span>
					</td>
					<td :class="[TD, columnClass('updatedAt')]" class="whitespace-nowrap text-ink-muted">{{ at(run.updated_at) }}</td>
				</tr>
				<tr v-if="runs.length === 0">
					<td colspan="5" :class="EMPTY_ROW">{{ t('common.noResults') }}</td>
				</tr>
			</tbody>
		</table>
	</div>
</template>
