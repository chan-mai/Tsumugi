<script setup lang="ts">
import { flip, offset, shift, useFloating, type VirtualElement } from '@floating-ui/vue';
import { ChevronRight, CircleAlert } from '@lucide/vue';
import { useNow } from '@vueuse/core';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { RunNode } from '../../api';
import { formatTimestamp, timeLocale } from '../../time';
import StatusCell from '../StatusCell.vue';
import { CHILD_PAGE, formatDuration, waterfallLayout, type NodeRow, type Segment } from './waterfallLayout';

const props = defineProps<{ nodes: RunNode[] }>();
const emit = defineEmits<{ (event: 'select', jobId: string): void; (event: 'run', runId: string): void }>();
const { t } = useI18n();

const { now, pause, resume } = useNow({ interval: 1_000, controls: true });
const collapsed = ref(new Set<string>());
const shown = ref(new Map<string, number>());

const layout = computed(() => waterfallLayout(props.nodes, now.value.getTime(), { collapsed: collapsed.value, shown: shown.value }));
const span = computed(() => Math.max(layout.value.end - layout.value.start, 1));
const live = computed(() => layout.value.rows.some((row) => row.kind === 'node' && row.segments.some((s) => s.open)));

// 実行中のみ毎秒伸長
watch(live, (active) => (active ? resume() : pause()), { immediate: true });

const pct = (at: number) => ((at - layout.value.start) / span.value) * 100;

function barStyle(segment: Segment) {
	return { left: `${pct(segment.start)}%`, width: `${Math.max(pct(segment.end) - pct(segment.start), 0)}%` };
}

const TONE: Record<string, { fill: string; text: string }> = {
	COMPLETED: { fill: 'bg-positive', text: 'text-positive' },
	FAILED: { fill: 'bg-critical', text: 'text-critical' },
	STALLED: { fill: 'bg-critical', text: 'text-critical' },
	RUNNING: { fill: 'bg-info', text: 'text-info' },
	CANCELLED: { fill: 'bg-ink-subtle', text: 'text-ink-subtle' },
};
const NEUTRAL = { fill: 'bg-ink-subtle', text: 'text-ink-subtle' };

const FAILURE = new Set(['FAILED', 'STALLED']);
const failed = (row: NodeRow) => FAILURE.has(row.node.state);

// 行背景, ホバー時は濃く
function rowClass(row: NodeRow) {
	const active = hovered.value?.node.id === row.node.id;
	if (failed(row)) return active ? 'bg-critical-soft' : 'bg-critical-soft/50 hover:bg-critical-soft';
	return active ? 'bg-neutral-soft' : 'hover:bg-neutral-soft';
}

function labelClass(row: NodeRow) {
	if (failed(row)) return 'font-medium text-critical';
	if (row.node.state === 'SKIPPED' || row.node.state === 'CANCELLED') return 'text-ink-subtle line-through';
	return row.depth === 0 ? 'font-medium text-ink' : 'text-ink-muted';
}

function barClass(segment: Segment) {
	// 終了前の実行区間はノードの状態によらず実行中
	const tone = (segment.kind === 'running' || segment.kind === 'span') && segment.open ? TONE.RUNNING! : (TONE[segment.state] ?? NEUTRAL);
	switch (segment.kind) {
		case 'queued':
			return ['border border-dashed border-line-strong bg-neutral-soft', segment.open ? 'animate-pulse' : ''];
		case 'attempt':
			return ['opacity-40', tone.fill];
		case 'span':
			// 子の範囲の集計, 実行区間ではない
			return [
				'border border-current bg-[repeating-linear-gradient(135deg,currentColor_0_1.5px,transparent_1.5px_6px)] opacity-70',
				tone.text,
			];
		default:
			return [tone.fill, segment.open ? 'animate-pulse' : '', FAILURE.has(segment.state) ? 'ring-2 ring-critical/30' : ''];
	}
}

const total = (row: NodeRow) =>
	row.segments.length === 0 ? null : Math.max(...row.segments.map((s) => s.end)) - Math.min(...row.segments.map((s) => s.start));

const durationOf = (row: NodeRow, kind: Segment['kind']) =>
	row.segments.filter((s) => s.kind === kind).reduce((sum, s) => sum + (s.end - s.start), 0);

function toggle(id: string) {
	const next = new Set(collapsed.value);
	if (!next.delete(id)) next.add(id);
	collapsed.value = next;
}

function showMore(parent: string) {
	shown.value = new Map(shown.value).set(parent, (shown.value.get(parent) ?? CHILD_PAGE) + CHILD_PAGE);
}

function open(row: NodeRow) {
	if (row.node.job_id) emit('select', row.node.job_id);
	else if (row.node.child_run_id) emit('run', row.node.child_run_id);
	else if (row.childCount > 0) toggle(row.node.id);
}

const hovered = ref<NodeRow | null>(null);
// ツールチップはカーソル位置基準
const cursor = ref<VirtualElement | null>(null);
const tooltip = ref<HTMLElement | null>(null);
const { floatingStyles } = useFloating(cursor, tooltip, {
	placement: 'bottom-start',
	strategy: 'fixed',
	middleware: [offset(12), flip(), shift({ padding: 8 })],
});

function hover(row: NodeRow, event: MouseEvent) {
	hovered.value = row;
	const { clientX: x, clientY: y } = event;
	cursor.value = { getBoundingClientRect: () => new DOMRect(x, y, 0, 0) };
}

function leave() {
	hovered.value = null;
}

const duration = (ms: number) => formatDuration(ms, timeLocale.value);
const tickLabel = (offset: number) => (offset === 0 ? '0' : duration(offset));
</script>

<template>
	<div class="overflow-hidden rounded-2xl border border-line bg-surface text-sm">
		<p v-if="layout.rows.length === 0" class="px-4 py-10 text-center text-ink-subtle">{{ t('waterfall.empty') }}</p>

		<div v-else class="grid grid-cols-[minmax(9rem,14rem)_1fr]">
			<div class="h-9 border-r border-b border-line bg-canvas" />
			<div class="relative h-9 border-b border-line bg-canvas px-3">
				<div class="relative h-full">
					<span
						v-for="(tick, index) in layout.ticks"
						v-show="index === 0 || pct(layout.start + tick.offset) < 94"
						:key="tick.offset"
						class="absolute top-1/2 -translate-y-1/2 text-xs whitespace-nowrap text-ink-subtle tabular-nums"
						:class="index === 0 ? '' : '-translate-x-1/2'"
						:style="{ left: `${pct(layout.start + tick.offset)}%` }"
					>
						{{ tickLabel(tick.offset) }}
					</span>
				</div>
			</div>

			<template v-for="row in layout.rows" :key="row.kind === 'node' ? row.node.id : `more:${row.parent}`">
				<template v-if="row.kind === 'node'">
					<div
						class="flex h-9 min-w-0 cursor-pointer items-center gap-1 border-r border-line pr-3 transition-colors"
						:class="rowClass(row)"
						:style="{ paddingLeft: `${12 + row.depth * 16}px` }"
						@click="open(row)"
						@mousemove="hover(row, $event)"
						@mouseleave="leave"
					>
						<button
							v-if="row.childCount > 0"
							type="button"
							class="flex size-5 shrink-0 items-center justify-center rounded border-none bg-transparent text-ink-muted hover:bg-line"
							:aria-label="row.collapsed ? t('waterfall.expand', { id: row.node.id }) : t('waterfall.collapse', { id: row.node.id })"
							:aria-expanded="!row.collapsed"
							@click.stop="toggle(row.node.id)"
						>
							<ChevronRight class="size-3.5 transition-transform" :class="row.collapsed ? '' : 'rotate-90'" aria-hidden="true" />
						</button>
						<span v-else class="size-5 shrink-0" />
						<span class="min-w-0 flex-1 truncate" :class="labelClass(row)">{{ row.node.id }}</span>
						<CircleAlert v-if="failed(row)" class="size-3.5 shrink-0 text-critical" aria-hidden="true" />
						<span class="shrink-0 text-xs text-ink-subtle tabular-nums">{{ total(row) === null ? '' : duration(total(row)!) }}</span>
					</div>
					<div
						class="relative h-9 cursor-pointer px-3 transition-colors"
						:class="rowClass(row)"
						@click="open(row)"
						@mousemove="hover(row, $event)"
						@mouseleave="leave"
					>
						<div class="relative h-full">
							<span
								v-for="tick in layout.ticks"
								:key="tick.offset"
								class="absolute inset-y-0 w-px bg-line"
								:style="{ left: `${pct(layout.start + tick.offset)}%` }"
								aria-hidden="true"
							/>
							<span
								v-for="(segment, index) in row.segments"
								:key="index"
								class="absolute top-2 bottom-2 min-w-[3px] rounded"
								:class="barClass(segment)"
								:style="barStyle(segment)"
							/>
						</div>
					</div>
				</template>
				<template v-else>
					<div class="flex h-9 items-center border-r border-line pr-3" :style="{ paddingLeft: `${36 + row.depth * 16}px` }">
						<button
							type="button"
							class="border-none bg-transparent p-0 text-xs text-accent-strong underline-offset-2 hover:underline"
							@click="showMore(row.parent)"
						>
							{{ t('waterfall.showMore', { count: Math.min(row.remaining, CHILD_PAGE) }) }}
						</button>
					</div>
					<div class="h-9" />
				</template>
			</template>
		</div>

		<Teleport to="body">
			<div
				v-if="hovered"
				ref="tooltip"
				class="pointer-events-none z-50 w-64 rounded-xl border border-line bg-surface p-3 text-xs shadow-[0_8px_24px_rgb(0_0_0/0.08)]"
				:style="floatingStyles"
			>
				<div class="mb-2 flex items-center justify-between gap-2">
					<span class="truncate font-medium text-ink">{{ hovered.node.id }}</span>
					<StatusCell :state="hovered.node.state" />
				</div>
				<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-ink-muted">
					<dt>{{ t('common.binding') }}</dt>
					<dd class="truncate text-right text-ink">{{ hovered.node.binding }}</dd>
					<template v-if="durationOf(hovered, 'queued') > 0">
						<dt>{{ t('waterfall.queued') }}</dt>
						<dd class="text-right text-ink tabular-nums">{{ duration(durationOf(hovered, 'queued')) }}</dd>
					</template>
					<template v-if="hovered.segments.some((s) => s.kind === 'running')">
						<dt>{{ t('waterfall.execution') }}</dt>
						<dd class="text-right text-ink tabular-nums">{{ duration(durationOf(hovered, 'running')) }}</dd>
					</template>
					<template v-if="total(hovered) !== null">
						<dt>{{ t('waterfall.total') }}</dt>
						<dd class="text-right text-ink tabular-nums">{{ duration(total(hovered)!) }}</dd>
					</template>
					<template v-if="hovered.node.attempts_log.length > 1">
						<dt>{{ t('common.attempts') }}</dt>
						<dd class="text-right text-ink tabular-nums">{{ hovered.node.attempts_log.length }}</dd>
					</template>
					<template v-if="hovered.node.started_at !== null">
						<dt>{{ t('common.startedAt') }}</dt>
						<dd class="text-right text-ink">{{ formatTimestamp(hovered.node.started_at) }}</dd>
					</template>
					<template v-if="hovered.segments.length === 0">
						<dt class="col-span-2">{{ t('waterfall.notStarted') }}</dt>
					</template>
				</dl>
				<p v-if="hovered.node.error" class="mt-2 line-clamp-3 rounded-lg bg-critical-soft px-2 py-1.5 font-mono break-all text-critical">
					{{ hovered.node.error }}
				</p>
			</div>
		</Teleport>
	</div>
</template>
