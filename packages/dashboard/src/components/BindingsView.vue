<script setup lang="ts">
import { ref } from 'vue';
import { getDiagnostics, isUnauthorized, resetPolicy, updatePolicy, type BindingDiagnostics } from '../api';

const emit = defineEmits<{ unauthorized: [] }>();

const entries = ref<[string, BindingDiagnostics][]>([]);
const error = ref<string | null>(null);
const message = ref<string | null>(null);
/** 操作中のbinding, 二度押しを防ぐ */
const busy = ref<string | null>(null);
/** 入力中の同時実行数, 反映するまでは画面の値だけを持つ. 空欄では数値にならない */
const draft = ref<Record<string, number | string>>({});

/** 入力が0以上の整数の時だけ送る, 空欄のまま送るとサーバに断られる */
const draftValue = (binding: string): number | null => {
	const value = draft.value[binding];
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
};

/** 遅れて届いた古い応答で最新の結果を上書きしないための連番 */
let generation = 0;

async function load() {
	const requested = ++generation;
	try {
		const loaded = await getDiagnostics();
		if (requested !== generation) return;
		entries.value = Object.entries(loaded.bindings).sort(([a], [b]) => (a < b ? -1 : 1));
		for (const [binding, entry] of entries.value) {
			// 入力中の値は上書きしない, 定期更新のたびに戻ると入力できない
			if (draft.value[binding] === undefined) draft.value[binding] = entry.policy.concurrency;
		}
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

async function act(binding: string, run: () => Promise<unknown>, done: string) {
	busy.value = binding;
	try {
		await run();
		message.value = `${binding}: ${done}`;
	} catch (e) {
		message.value = e instanceof Error ? e.message : String(e);
	} finally {
		busy.value = null;
		// 操作の後はサーバの値へ引き直す, resetで戻った値が入力欄に残らないようにする
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

/** 投入が止まっている理由, 複数該当する場合は全て出す */
const blockedBy = (entry: BindingDiagnostics) =>
	Object.entries(entry.blocked)
		.filter(([, on]) => on)
		.map(([name]) => name)
		.join(', ');

const rateOf = (entry: BindingDiagnostics) =>
	entry.policy.rate === null ? '-' : `${entry.policy.rate.tokens} / ${entry.policy.rate.intervalMs} ms`;

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
						<td colspan="8" class="h-24 text-center text-muted-foreground">No bindings.</td>
					</tr>
				</tbody>
			</table>
		</div>
	</div>
</template>
