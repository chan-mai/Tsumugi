<script setup lang="ts">
import StatusCell from './StatusCell.vue';
import type { Attempt } from '../api';

const props = defineProps<{ attempts: Attempt[] }>();

const at = (value: number | null) => (value ? new Date(value).toLocaleString() : '-');

/** 開始が取れていない試行では所要も出せない */
const durationOf = (a: Attempt) => (a.started_at === null ? '-' : `${a.finished_at - a.started_at} ms`);

/** 古い順に並べる, 1回目から読むほうが経過を追いやすい */
const ordered = () => [...props.attempts].sort((x, y) => x.attempt - y.attempt);
</script>

<template>
	<!-- 1回で成功したジョブは履歴を持たない, 節ごと出さないと欠落に見える -->
	<div v-if="attempts.length > 0">
		<p class="mb-1 text-muted-foreground">Result</p>
		<div class="space-y-3">
			<div v-for="a in ordered()" :key="a.attempt" class="rounded-card border border-border p-3">
				<p class="mb-2 font-medium">#{{ a.attempt }}</p>
				<dl class="grid gap-y-1 sm:grid-cols-[9rem_1fr]">
					<dt class="text-muted-foreground">Status</dt>
					<dd><StatusCell :state="a.state" /></dd>
					<dt class="text-muted-foreground">StartedAt</dt>
					<dd>{{ at(a.started_at) }}</dd>
					<dt class="text-muted-foreground">FinishedAt</dt>
					<dd>{{ at(a.finished_at) }}</dd>
					<dt class="text-muted-foreground">Processing Time</dt>
					<dd class="tabular-nums">{{ durationOf(a) }}</dd>
					<template v-if="a.error">
						<dt class="text-muted-foreground">Error</dt>
						<dd>
							<pre class="overflow-auto rounded-card bg-muted p-2 text-xs whitespace-pre-wrap">{{ a.error }}</pre>
						</dd>
					</template>
				</dl>
			</div>
		</div>
	</div>
</template>
