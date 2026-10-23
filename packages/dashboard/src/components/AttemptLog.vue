<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { Attempt } from '../api';
import { formatTimestamp } from '../time';
import { CODE } from '../ui';
import StatusCell from './StatusCell.vue';

const props = defineProps<{ attempts: Attempt[] }>();
const { t } = useI18n();

const at = (value: number | null) => (value === null ? '-' : formatTimestamp(value));

const durationOf = (a: Attempt) => (a.started_at === null ? '-' : `${a.finished_at - a.started_at} ms`);

const ordered = () => [...props.attempts].sort((x, y) => x.attempt - y.attempt);
</script>

<template>
	<section v-if="attempts.length > 0">
		<h3 class="mb-2 text-base font-semibold">{{ t('attempts.title') }}</h3>
		<div class="space-y-3">
			<div v-for="a in ordered()" :key="a.attempt" class="rounded-xl border border-line p-4">
				<div class="mb-2 flex items-center gap-2">
					<span class="font-medium tabular-nums">#{{ a.attempt }}</span>
					<StatusCell :state="a.state" />
				</div>
				<dl class="grid gap-y-1 sm:grid-cols-[9rem_1fr]">
					<dt class="text-ink-muted">{{ t('attempts.startedAt') }}</dt>
					<dd>{{ at(a.started_at) }}</dd>
					<dt class="text-ink-muted">{{ t('attempts.finishedAt') }}</dt>
					<dd>{{ at(a.finished_at) }}</dd>
					<dt class="text-ink-muted">{{ t('attempts.processingTime') }}</dt>
					<dd class="tabular-nums">{{ durationOf(a) }}</dd>
				</dl>
				<pre v-if="a.error" :class="CODE" class="mt-2 whitespace-pre-wrap text-critical">{{ a.error }}</pre>
			</div>
		</div>
	</section>
</template>
