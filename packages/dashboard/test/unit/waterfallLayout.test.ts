import { describe, expect, it } from 'vitest';
import type { RunNode } from '../../src/api';
import { CHILD_PAGE, formatDuration, tickStep, waterfallLayout, type NodeRow } from '../../src/components/waterfall/waterfallLayout';

const node = (over: Partial<RunNode> & { id: string }): RunNode => ({
	binding: 'GREET',
	state: 'COMPLETED',
	container: false,
	parent: null,
	origin: 'static',
	after: [],
	job_id: null,
	child_run_id: null,
	result: null,
	error: null,
	position: 0,
	created_at: 0,
	updated_at: 0,
	queued_at: null,
	run_after: null,
	started_at: null,
	finished_at: null,
	attempts_log: [],
	...over,
});

const job = (id: string, over: Partial<RunNode> = {}) => node({ id, job_id: `GREET#0:${id}`, ...over });

const nodeRows = (rows: ReturnType<typeof waterfallLayout>['rows']) => rows.filter((row): row is NodeRow => row.kind === 'node');
const rowOf = (result: ReturnType<typeof waterfallLayout>, id: string) => nodeRows(result.rows).find((row) => row.node.id === id)!;

describe('ウォーターフォールの配置', () => {
	it('親子を前順で並べ兄弟はposition順', () => {
		const result = waterfallLayout(
			[
				node({ id: 'b', position: 1 }),
				node({ id: 'a', position: 0, container: true }),
				node({ id: 'a:1', parent: 'a', position: 1 }),
				node({ id: 'a:0', parent: 'a', position: 0 }),
			],
			0,
		);
		expect(nodeRows(result.rows).map((row) => [row.node.id, row.depth])).toEqual([
			['a', 0],
			['a:0', 1],
			['a:1', 1],
			['b', 0],
		]);
	});

	it('キュー待ちと実行の区間をジョブの時刻から作る', () => {
		const result = waterfallLayout([job('n', { queued_at: 100, started_at: 300, finished_at: 700 })], 1_000);
		expect(rowOf(result, 'n').segments).toEqual([
			{ kind: 'queued', start: 100, end: 300, state: 'COMPLETED', open: false },
			{ kind: 'running', start: 300, end: 700, state: 'COMPLETED', open: false },
		]);
		expect([result.start, result.end]).toEqual([100, 700]);
	});

	it('実行中の区間は現在時刻まで伸ばす', () => {
		const result = waterfallLayout([job('n', { state: 'RUNNING', queued_at: 100, started_at: 300 })], 900);
		expect(rowOf(result, 'n').segments.at(-1)).toMatchObject({ kind: 'running', end: 900, open: true });
	});

	it('未開始のキュー待ちは現在時刻まで', () => {
		const result = waterfallLayout([job('n', { state: 'QUEUED', queued_at: 100 })], 400);
		expect(rowOf(result, 'n').segments).toEqual([{ kind: 'queued', start: 100, end: 400, state: 'QUEUED', open: true }]);
	});

	it('過去の失敗試行を区間に含め再試行待ちは直前の試行終了から', () => {
		const result = waterfallLayout(
			[
				job('n', {
					queued_at: 100,
					started_at: 600,
					finished_at: 800,
					attempts_log: [
						{ attempt: 2, state: 'COMPLETED', started_at: 600, finished_at: 800, error: null },
						{ attempt: 1, state: 'FAILED', started_at: 200, finished_at: 400, error: 'boom' },
					],
				}),
			],
			1_000,
		);
		expect(rowOf(result, 'n').segments).toEqual([
			{ kind: 'attempt', start: 200, end: 400, state: 'FAILED', attempt: 1, open: false },
			{ kind: 'queued', start: 400, end: 600, state: 'COMPLETED', open: false },
			{ kind: 'running', start: 600, end: 800, state: 'COMPLETED', attempt: 2, open: false },
		]);
	});

	it('containerは子の範囲を期間とする', () => {
		const result = waterfallLayout(
			[
				node({ id: 'fan', container: true, state: 'RUNNING' }),
				job('fan:0', { parent: 'fan', queued_at: 100, started_at: 150, finished_at: 300 }),
				job('fan:1', { parent: 'fan', position: 1, state: 'RUNNING', queued_at: 120, started_at: 200 }),
			],
			500,
		);
		expect(rowOf(result, 'fan').segments).toEqual([{ kind: 'span', start: 100, end: 500, state: 'RUNNING', open: true }]);
	});

	it('ジョブも子も持たないノードは作成時刻からの区間を作らない', () => {
		// 静的ノードはrun開始時に一括作成
		const result = waterfallLayout([node({ id: 'sub', state: 'COMPLETED', created_at: 0, updated_at: 900, child_run_id: 'R:1' })], 1_000);
		expect(rowOf(result, 'sub').segments).toEqual([]);
	});

	it('subflowは子runの期間を実行区間とする', () => {
		const result = waterfallLayout([node({ id: 'sub', child_run_id: 'R:1', queued_at: 100, started_at: 100, finished_at: 600 })], 1_000);
		expect(rowOf(result, 'sub').segments).toEqual([{ kind: 'running', start: 100, end: 600, state: 'COMPLETED', open: false }]);
	});

	it('PENDINGのノードは区間を持たない', () => {
		const result = waterfallLayout([node({ id: 'n', state: 'PENDING', created_at: 50, updated_at: 50 })], 100);
		expect(rowOf(result, 'n').segments).toEqual([]);
		expect(result.ticks).toEqual([]);
	});

	it('折りたたんだノードの子は並べない', () => {
		const result = waterfallLayout([node({ id: 'fan', container: true }), node({ id: 'fan:0', parent: 'fan' })], 0, {
			collapsed: new Set(['fan']),
		});
		expect(nodeRows(result.rows).map((row) => row.node.id)).toEqual(['fan']);
		expect(rowOf(result, 'fan')).toMatchObject({ childCount: 1, collapsed: true });
	});

	it('子は上限件数ごとに表示し残数を返す', () => {
		const many = Array.from({ length: CHILD_PAGE + 5 }, (_, i) => node({ id: `fan:${i}`, parent: 'fan', position: i }));
		const result = waterfallLayout([node({ id: 'fan', container: true }), ...many], 0);
		expect(nodeRows(result.rows)).toHaveLength(CHILD_PAGE + 1);
		expect(result.rows.at(-1)).toEqual({ kind: 'more', parent: 'fan', depth: 1, remaining: 5 });

		const expanded = waterfallLayout([node({ id: 'fan', container: true }), ...many], 0, { shown: new Map([['fan', CHILD_PAGE * 2]]) });
		expect(expanded.rows.every((row) => row.kind === 'node')).toBe(true);
	});

	it('存在しない親を持つノードはルートに置く', () => {
		const result = waterfallLayout([node({ id: 'orphan', parent: 'missing' })], 0);
		expect(rowOf(result, 'orphan').depth).toBe(0);
	});

	it('空の入力で例外にならない', () => {
		expect(waterfallLayout([], 0)).toEqual({ rows: [], start: 0, end: 0, ticks: [] });
	});
});

describe('目盛り', () => {
	it('約5分割になる間隔を選ぶ', () => {
		expect(tickStep(1_000)).toBe(200);
		expect(tickStep(12_000)).toBe(5_000);
		expect(tickStep(90 * 60_000)).toBe(1_800_000);
	});

	it('範囲の先頭から間隔ごとに置く', () => {
		const result = waterfallLayout([job('n', { queued_at: 0, started_at: 0, finished_at: 1_000 })], 0);
		expect(result.ticks.map((tick) => tick.offset)).toEqual([0, 200, 400, 600, 800, 1_000]);
	});

	// Node 22はIntl.DurationFormat未実装, 対象はブラウザ
	it.skipIf(!('DurationFormat' in Intl))('所要時間を単位付きで表示する', () => {
		expect(formatDuration(0, 'en')).toBe('0ms');
		expect(formatDuration(450, 'en')).toBe('450ms');
		expect(formatDuration(1_234, 'en')).toBe('1s 234ms');
		expect(formatDuration(42_500, 'en')).toBe('42s');
		expect(formatDuration(125_000, 'en')).toBe('2m 5s');
		expect(formatDuration(3_600_000, 'en')).toBe('1h');
	});
});
