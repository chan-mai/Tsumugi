import type { RunNode } from '../../api';

export type Segment = {
	/** queued: 実行開始待ち, running: 最新試行, attempt: 過去の試行, span: 子の範囲 */
	kind: 'queued' | 'running' | 'attempt' | 'span';
	start: number;
	end: number;
	state: string;
	attempt?: number;
	/** 終了時刻が現在時刻の仮置き */
	open: boolean;
};

export type NodeRow = {
	kind: 'node';
	node: RunNode;
	depth: number;
	segments: Segment[];
	childCount: number;
	collapsed: boolean;
};

export type MoreRow = { kind: 'more'; parent: string; depth: number; remaining: number };

export type Row = NodeRow | MoreRow;

export type Tick = { offset: number };

export type Waterfall = { rows: Row[]; start: number; end: number; ticks: Tick[] };

export type WaterfallOptions = {
	collapsed?: ReadonlySet<string>;
	/** 親ごとの表示件数, 未指定はCHILD_PAGE */
	shown?: ReadonlyMap<string, number>;
};

export const CHILD_PAGE = 20;

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'STALLED', 'SKIPPED']);

const TICK_STEPS = [
	1, 2, 5, 10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000,
	3_600_000, 7_200_000, 21_600_000, 43_200_000, 86_400_000,
];
const TICK_TARGET = 5;

function timedSegments(node: RunNode, now: number): Segment[] {
	if (node.queued_at === null) return [];
	const active = !TERMINAL.has(node.state);
	const latestEnd = node.finished_at ?? now;

	// 最新試行は開始時刻が一致, 1回目成功の導出分も同様
	const previous = node.attempts_log
		.filter((a) => a.started_at !== null && a.started_at !== node.started_at)
		.map<Segment>((a) => ({ kind: 'attempt', start: a.started_at!, end: a.finished_at, state: a.state, attempt: a.attempt, open: false }))
		.sort((x, y) => x.start - y.start);

	const segments: Segment[] = [...previous];
	// 再試行待ちは直前の試行終了から
	const queueStart = Math.max(node.queued_at, ...previous.map((s) => s.end));
	const queueEnd = node.started_at ?? latestEnd;
	if (queueEnd > queueStart)
		segments.push({ kind: 'queued', start: queueStart, end: queueEnd, state: node.state, open: active && node.started_at === null });
	if (node.started_at !== null) {
		const current = node.attempts_log.find((a) => a.started_at === node.started_at);
		segments.push({
			kind: 'running',
			start: node.started_at,
			end: Math.max(node.started_at, latestEnd),
			state: node.state,
			...(current ? { attempt: current.attempt } : {}),
			open: node.finished_at === null,
		});
	}
	return segments;
}

export function waterfallLayout(nodes: RunNode[], now: number, options: WaterfallOptions = {}): Waterfall {
	const ids = new Set(nodes.map((node) => node.id));
	const children = new Map<string | null, RunNode[]>();
	for (const node of nodes) {
		const parent = node.parent !== null && ids.has(node.parent) ? node.parent : null;
		const list = children.get(parent) ?? [];
		list.push(node);
		children.set(parent, list);
	}
	for (const list of children.values()) list.sort((a, b) => a.position - b.position);

	// 子の区間を先に確定, containerの期間は子の範囲
	const segments = new Map<string, Segment[]>();
	const resolve = (node: RunNode): Segment[] => {
		const cached = segments.get(node.id);
		if (cached) return cached;
		let own: Segment[];
		// subflowは子runの時刻をAPIが設定
		if (node.queued_at !== null) own = timedSegments(node, now);
		else {
			const nested = (children.get(node.id) ?? []).flatMap(resolve);
			// ノード作成時刻はrun開始時刻, 実行期間ではない
			own =
				nested.length > 0
					? [
							{
								kind: 'span',
								start: Math.min(...nested.map((s) => s.start)),
								end: Math.max(...nested.map((s) => s.end)),
								state: node.state,
								open: nested.some((s) => s.open),
							},
						]
					: [];
		}
		segments.set(node.id, own);
		return own;
	};
	nodes.forEach(resolve);

	const all = [...segments.values()].flat();
	const start = all.length > 0 ? Math.min(...all.map((s) => s.start)) : 0;
	const end = all.length > 0 ? Math.max(...all.map((s) => s.end)) : 0;

	const rows: Row[] = [];
	const visit = (parent: string | null, depth: number) => {
		const list = children.get(parent) ?? [];
		const limit = parent === null ? list.length : (options.shown?.get(parent) ?? CHILD_PAGE);
		for (const node of list.slice(0, limit)) {
			const childCount = children.get(node.id)?.length ?? 0;
			const collapsed = options.collapsed?.has(node.id) ?? false;
			rows.push({ kind: 'node', node, depth, segments: segments.get(node.id) ?? [], childCount, collapsed });
			if (childCount > 0 && !collapsed) visit(node.id, depth + 1);
		}
		if (parent !== null && list.length > limit) rows.push({ kind: 'more', parent, depth, remaining: list.length - limit });
	};
	visit(null, 0);

	return { rows, start, end, ticks: ticks(end - start) };
}

export function tickStep(duration: number): number {
	return TICK_STEPS.find((step) => duration / step <= TICK_TARGET) ?? TICK_STEPS[TICK_STEPS.length - 1]!;
}

function ticks(duration: number): Tick[] {
	if (duration <= 0) return [];
	const step = tickStep(duration);
	const result: Tick[] = [];
	for (let offset = 0; offset <= duration; offset += step) result.push({ offset });
	return result;
}

const durationFormats = new Map<string, Intl.DurationFormat>();

// 1秒未満はミリ秒を常に表示, 0msの空文字回避
function durationFormat(locale: string | undefined, subSecond: boolean): Intl.DurationFormat {
	const key = `${locale ?? ''}|${subSecond}`;
	let format = durationFormats.get(key);
	if (!format) {
		format = new Intl.DurationFormat(locale, { style: 'narrow', ...(subSecond ? { millisecondsDisplay: 'always' } : {}) });
		durationFormats.set(key, format);
	}
	return format;
}

/** 10秒以上はミリ秒, 1時間以上は秒以下を省略 */
export function formatDuration(ms: number, locale?: string): string {
	const rounded = Math.max(0, Math.round(ms));
	if (rounded < 1_000) return durationFormat(locale, true).format({ milliseconds: rounded });
	const hours = Math.floor(rounded / 3_600_000);
	const minutes = Math.floor((rounded % 3_600_000) / 60_000);
	const seconds = Math.floor((rounded % 60_000) / 1_000);
	const format = durationFormat(locale, false);
	if (hours > 0) return format.format({ hours, minutes });
	if (rounded >= 10_000) return format.format({ minutes, seconds });
	return format.format({ seconds, milliseconds: rounded % 1_000 });
}
