<script setup lang="ts">
import { ref } from 'vue';
import { getDiagnostics, isUnauthorized, resetPolicy, updatePolicy, type BindingDiagnostics } from '../api';

const entries = ref<[string, BindingDiagnostics][]>([]);
const error = ref<string | null>(null);
const message = ref<string | null>(null);
const busy = ref<string | null>(null);
// 空欄は非数値
const draft = ref<Record<string, number | string>>({});

// 空欄はサーバ側でエラー
const draftValue = (binding: string): number | null => {
	const value = draft.value[binding];
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
};

// 遅延した旧応答による上書き防止用の連番
let generation = 0;

async function load() {
	const requested = ++generation;
	try {
		const loaded = await getDiagnostics();
		if (requested !== generation) return;
		entries.value = Object.entries(loaded.bindings).sort(([a], [b]) => (a < b ? -1 : 1));
		for (const [binding, entry] of entries.value) {
			// 定期更新での入力値リセット防止
			if (draft.value[binding] === undefined) draft.value[binding] = entry.policy.concurrency;
		}
		error.value = null;
	} catch (e) {
		if (requested !== generation) return;
		if (isUnauthorized(e)) return;
		error.value = e instanceof Error ? e.message : String(e);
	}
}

void load();
defineExpose({ load });

async function act(binding: string, run: () => Promise<unknown>, done: string) {
	busy.value = binding;
	try {
		await run();
		message.value = `${binding}: ${done}`;
	} catch (e) {
		message.value = e instanceof Error ? e.message : String(e);
	} finally {
		busy.value = null;
		// reset後の旧入力値残存防止
		delete draft.value[binding];
		await load();
	}
}

const setPaused = (binding: string, paused: boolean) =>
	act(binding, () => updatePolicy(binding, { paused }), paused ? 'paused' : 'resumed');

function applyConcurrency(binding: string) {
	const concurrency = draftValue(binding);
	if (concurrency === null) return;
	return act(binding, () => updatePolicy(binding, { concurrency }), 'concurrency updated');
}

const reset = (binding: string) => act(binding, () => resetPolicy(binding), 'reset to the static settings');

const blockedBy = (entry: BindingDiagnostics) =>
	Object.entries(entry.blocked)
		.filter(([, on]) => on)
		.map(([name]) => name)
		.join(', ');

const formatRate = (rate: { tokens: number; intervalMs: number } | null) =>
	rate === null ? '-' : `${rate.tokens} / ${rate.intervalMs} ms`;
const rateOf = (entry: BindingDiagnostics) => formatRate(entry.policy.rate);
const perKeyRateOf = (entry: BindingDiagnostics) => formatRate(entry.policy.perKeyRate);

const HEAD = 'h-12 px-4 text-left align-middle font-medium text-muted-foreground whitespace-nowrap';
const BTN = 'h-8 rounded-card border border-border px-3 text-sm hover:bg-accent disabled:opacity-50';
</script>

<template>
	<div class="space-y-4">
		<div class="flex flex-wrap items-center gap-2">
			<p class="text-sm text-muted-foreground">
				* The changes will be applied to all shards and take precedence over the static configuration. You can revert to the static
				configuration by clicking Reset.
			</p>
			<span v-if="message" class="text-sm text-muted-foreground">{{ message }}</span>
			<span v-if="error" class="text-sm text-destructive">Failed to load: {{ error }}</span>
		</div>

		<div class="relative w-full overflow-x-auto rounded-card border border-border">
			<table class="w-full caption-bottom text-sm">
				<thead class="[&_tr]:border-b [&_tr]:border-border">
					<tr>
						<th :class="HEAD">Binding</th>
						<th :class="HEAD">Active</th>
						<th :class="HEAD">Outbox</th>
						<th :class="HEAD">Blocked</th>
						<th :class="HEAD">Concurrency</th>
						<th :class="HEAD">Per key</th>
						<th :class="HEAD">Rate</th>
						<th :class="HEAD">Per-key rate</th>
						<th :class="HEAD">Actions</th>
					</tr>
				</thead>
				<tbody class="[&_tr:last-child]:border-0">
					<tr v-for="[binding, entry] in entries" :key="binding" class="border-b border-border">
						<td class="p-4 align-middle">
							{{ binding }}
							<span v-if="entry.policy.paused" class="ml-2 rounded-card bg-accent px-2 py-0.5 text-xs">paused</span>
						</td>
						<td class="p-4 align-middle tabular-nums">{{ entry.active }}</td>
						<td class="p-4 align-middle tabular-nums">{{ entry.outbox }}</td>
						<td class="p-4 align-middle text-muted-foreground">{{ blockedBy(entry) || '-' }}</td>
						<td class="p-4 align-middle">
							<div class="flex items-center gap-1">
								<input
									v-model.number="draft[binding]"
									type="number"
									min="0"
									class="h-8 w-20 rounded-card border border-border bg-background px-2 text-sm"
								/>
								<button
									type="button"
									:class="BTN"
									:disabled="busy === binding || draftValue(binding) === null || draft[binding] === entry.policy.concurrency"
									@click="applyConcurrency(binding)"
								>
									Apply
								</button>
							</div>
						</td>
						<td class="p-4 align-middle tabular-nums">{{ entry.policy.perKeyConcurrency }}</td>
						<td class="p-4 align-middle tabular-nums">{{ rateOf(entry) }}</td>
						<td class="p-4 align-middle tabular-nums">{{ perKeyRateOf(entry) }}</td>
						<td class="p-4 align-middle">
							<div class="flex items-center gap-1">
								<button type="button" :class="BTN" :disabled="busy === binding" @click="setPaused(binding, !entry.policy.paused)">
									{{ entry.policy.paused ? 'Resume' : 'Pause' }}
								</button>
								<button type="button" :class="BTN" :disabled="busy === binding" @click="reset(binding)">Reset</button>
							</div>
						</td>
					</tr>
					<tr v-if="entries.length === 0">
						<td colspan="9" class="h-24 text-center text-muted-foreground">No bindings.</td>
					</tr>
				</tbody>
			</table>
		</div>
	</div>
</template>
