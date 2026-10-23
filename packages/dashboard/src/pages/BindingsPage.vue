<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import LoadingState from '../components/LoadingState.vue';
import PageHeader from '../components/PageHeader.vue';
import { confirmAction } from '../composables/useConfirm';
import { onRefresh } from '../composables/useAutoRefresh';
import { getDiagnostics, isUnauthorized, resetPolicy, updatePolicy, type BindingDiagnostics } from '../api';
import { button, EMPTY_ROW, ERROR_TEXT, MUTED_TEXT, TABLE, TABLE_WRAP, TBODY, TD, TH, THEAD } from '../ui';

const { t } = useI18n();

const entries = ref<[string, BindingDiagnostics][]>([]);
const error = ref<string | null>(null);
const message = ref<string | null>(null);
const busy = ref<string | null>(null);
// 初回取得完了の有無, 取得前の空一覧表示防止
const loaded = ref(false);
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
		const result = await getDiagnostics();
		if (requested !== generation) return;
		loaded.value = true;
		entries.value = Object.entries(result.bindings).sort(([a], [b]) => (a < b ? -1 : 1));
		for (const [binding, entry] of entries.value) {
			// 定期更新での入力値リセット防止
			if (draft.value[binding] === undefined) draft.value[binding] = entry.policy.concurrency;
		}
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

async function setPaused(binding: string, paused: boolean) {
	const confirmed = await confirmAction({
		title: t(paused ? 'confirm.pause' : 'confirm.resume', { name: binding }),
		confirmLabel: t(paused ? 'common.pause' : 'common.resume'),
		danger: paused,
	});
	if (confirmed) await act(binding, () => updatePolicy(binding, { paused }), paused ? t('bindings.donePaused') : t('bindings.doneResumed'));
}

async function applyConcurrency(binding: string) {
	const concurrency = draftValue(binding);
	if (concurrency === null) return;
	const confirmed = await confirmAction({
		title: t('confirm.applyConcurrency', { name: binding, value: concurrency }),
		confirmLabel: t('bindings.apply'),
	});
	if (confirmed) await act(binding, () => updatePolicy(binding, { concurrency }), t('bindings.doneConcurrency'));
}

async function reset(binding: string) {
	const confirmed = await confirmAction({
		title: t('confirm.reset', { name: binding }),
		confirmLabel: t('common.reset'),
		danger: true,
	});
	if (confirmed) await act(binding, () => resetPolicy(binding), t('bindings.doneReset'));
}

const blockedBy = (entry: BindingDiagnostics) =>
	Object.entries(entry.blocked)
		.filter(([, on]) => on)
		.map(([name]) => name)
		.join(', ');

const formatRate = (rate: { tokens: number; intervalMs: number } | null) =>
	rate === null ? '-' : `${rate.tokens} / ${rate.intervalMs} ms`;
const rateOf = (entry: BindingDiagnostics) => formatRate(entry.policy.rate);
const perKeyRateOf = (entry: BindingDiagnostics) => formatRate(entry.policy.perKeyRate);
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
						<th :class="TH">{{ t('common.binding') }}</th>
						<th :class="TH">{{ t('bindings.active') }}</th>
						<th :class="TH">{{ t('bindings.outbox') }}</th>
						<th :class="TH">{{ t('bindings.blocked') }}</th>
						<th :class="TH">{{ t('bindings.concurrency') }}</th>
						<th :class="TH">{{ t('bindings.perKey') }}</th>
						<th :class="TH">{{ t('bindings.rate') }}</th>
						<th :class="TH">{{ t('bindings.perKeyRate') }}</th>
						<th :class="TH" />
					</tr>
				</thead>
				<tbody :class="TBODY">
					<tr v-for="[binding, entry] in entries" :key="binding">
						<td :class="TD" class="font-medium whitespace-nowrap">
							{{ binding }}
							<span v-if="entry.policy.paused" class="ml-2 rounded-full bg-neutral-soft px-2 py-0.5 text-xs font-medium text-ink-muted">{{
								t('common.paused')
							}}</span>
						</td>
						<td :class="TD" class="text-ink-muted tabular-nums">{{ entry.active }}</td>
						<td :class="TD" class="text-ink-muted tabular-nums">{{ entry.outbox }}</td>
						<td :class="TD" class="text-ink-muted">{{ blockedBy(entry) || '-' }}</td>
						<td :class="TD">
							<div class="flex items-center gap-1">
								<input
									v-model.number="draft[binding]"
									type="number"
									min="0"
									class="h-8 w-20 rounded-lg border border-line-strong bg-surface px-2 text-sm outline-none focus:border-accent-strong"
								/>
								<button
									type="button"
									:class="button('secondary', 'sm')"
									:disabled="busy === binding || draftValue(binding) === null || draft[binding] === entry.policy.concurrency"
									@click="applyConcurrency(binding)"
								>
									{{ t('bindings.apply') }}
								</button>
							</div>
						</td>
						<td :class="TD" class="text-ink-muted tabular-nums">{{ entry.policy.perKeyConcurrency }}</td>
						<td :class="TD" class="text-ink-muted tabular-nums">{{ rateOf(entry) }}</td>
						<td :class="TD" class="text-ink-muted tabular-nums">{{ perKeyRateOf(entry) }}</td>
						<td :class="TD">
							<div class="flex items-center justify-end gap-1">
								<button
									type="button"
									:class="button('ghost', 'sm')"
									:disabled="busy === binding"
									@click="setPaused(binding, !entry.policy.paused)"
								>
									{{ entry.policy.paused ? t('common.resume') : t('common.pause') }}
								</button>
								<button type="button" :class="button('ghost', 'sm')" :disabled="busy === binding" @click="reset(binding)">
									{{ t('common.reset') }}
								</button>
							</div>
						</td>
					</tr>
					<tr v-if="entries.length === 0">
						<td colspan="9" :class="EMPTY_ROW">{{ t('bindings.empty') }}</td>
					</tr>
				</tbody>
			</table>
		</div>
	</div>
</template>
