import { describe, expect, it } from 'vitest';
import type { RunNode } from '../../src/api';
import { HANDLE_TOP, MAX_CHIPS, runLayout, type ChildData, type TaskData } from '../../src/components/graph/runLayout';

/**
 * グラフの配置
 *
 * 描画の実寸に依らず座標が決まるので,ここで形を固定できる
 */

const node = (over: Partial<RunNode> & { id: string }): RunNode => ({
	binding: 'GREET',
	state: 'COMPLETED',
	container: false,
	parent: null,
	origin: 'static',
	after: [],
	job_id: null,
	result: null,
	error: null,
	position: 0,
	created_at: 0,
	updated_at: 0,
	...over,
});

const child = (parent: string, index: number, state = 'COMPLETED') =>
	node({ id: `${parent}:${index}`, parent, origin: 'fanOut', state, position: index });

const taskOf = (result: ReturnType<typeof runLayout>, id: string) => result.nodes.find((n) => n.id === id);

describe('Runのグラフの配置', () => {
	it('ルートはtask, 実行時に増えたノードはchildになる', () => {
		const result = runLayout([
			node({ id: 'list' }),
			node({ id: 'greet', container: true, after: ['list'] }),
			child('greet', 0),
			child('greet', 1),
		]);

		expect(result.nodes.filter((n) => n.type === 'task').map((n) => n.id)).toEqual(['list', 'greet']);
		const chip = taskOf(result, 'greet:0');
		expect(chip?.type).toBe('child');
		expect(chip?.parentNode).toBe('greet');
		expect(chip?.extent).toBe('parent');
		// 親の下での名前だけを出す
		expect((chip?.data as ChildData).label).toBe('0');
	});

	it('afterの数だけ辺が出る', () => {
		const result = runLayout([node({ id: 'a' }), node({ id: 'b' }), node({ id: 'c', after: ['a', 'b'] })]);

		expect(result.edges.map(({ id, source, target }) => ({ id, source, target }))).toEqual([
			{ id: 'a->c', source: 'a', target: 'c' },
			{ id: 'b->c', source: 'b', target: 'c' },
		]);
	});

	it('経路は水平と垂直だけで組む', () => {
		const result = runLayout([node({ id: 'a' }), node({ id: 'b', after: ['a'] }), node({ id: 'c', after: ['a', 'b'] })]);

		for (const edge of result.edges) {
			const route = edge.data.route;
			expect(route.length).toBeGreaterThanOrEqual(2);
			for (let i = 1; i < route.length; i++) {
				const previous = route[i - 1]!;
				const current = route[i]!;
				// 斜めの区間を作らない
				expect(previous.x === current.x || previous.y === current.y).toBe(true);
			}
		}
	});

	it('経路の端は箱の縁の頭の行に付く', () => {
		const result = runLayout([node({ id: 'a' }), node({ id: 'b', after: ['a'] })]);

		const edge = result.edges[0]!;
		const a = taskOf(result, 'a')!;
		const b = taskOf(result, 'b')!;
		const start = edge.data.route[0]!;
		const end = edge.data.route[edge.data.route.length - 1]!;
		expect(start.x).toBe(a.position.x + Number.parseFloat(a.style.width));
		expect(start.y).toBe(a.position.y + HANDLE_TOP);
		expect(end.x).toBe(b.position.x);
		expect(end.y).toBe(b.position.y + HANDLE_TOP);
	});

	it('実寸を渡すと見積もりより優先する', () => {
		const nodes = [node({ id: 'a' })];
		const estimated = Number.parseFloat(taskOf(runLayout(nodes), 'a')!.style.height);
		const measured = Number.parseFloat(taskOf(runLayout(nodes, new Map([['a', 200]])), 'a')!.style.height);

		expect(measured).toBeGreaterThan(estimated);
		// 上下の内側余白のぶんだけ中身より高い
		expect(measured).toBe(200 + 24);
	});

	it('同じ依存を重ねて書いても辺は1本になる', () => {
		const result = runLayout([node({ id: 'a' }), node({ id: 'b', after: ['a', 'a'] })]);
		expect(result.edges.map((edge) => edge.id)).toEqual(['a->b']);
	});

	it('自分への依存は辺にしない', () => {
		const result = runLayout([node({ id: 'a', after: ['a'] })]);
		expect(result.edges).toEqual([]);
	});

	it('同じ空きを通る辺は縦の走り位置を分ける', () => {
		const result = runLayout([node({ id: 'a' }), node({ id: 'b' }), node({ id: 'c', after: ['a'] }), node({ id: 'd', after: ['b'] })]);

		const xs = result.edges.map((edge) => edge.data.route[1]!.x);
		expect(new Set(xs).size).toBe(xs.length);
	});

	it('列を跨ぐ辺は箱の外を通る', () => {
		const result = runLayout([node({ id: 'a' }), node({ id: 'b', after: ['a'] }), node({ id: 'c', after: ['a', 'b'] })]);

		const boxes = result.nodes
			.filter((n) => n.type === 'task')
			.map((n) => ({
				l: n.position.x,
				r: n.position.x + Number.parseFloat(n.style.width),
				t: n.position.y,
				b: n.position.y + Number.parseFloat(n.style.height),
			}));

		// a->cはbの列を越すので, bに当たらないことを経路の全区間で見る
		const route = result.edges.find((edge) => edge.id === 'a->c')!.data.route;
		for (let i = 1; i < route.length; i++) {
			const from = route[i - 1]!;
			const to = route[i]!;
			for (let step = 0; step <= 20; step++) {
				const x = from.x + ((to.x - from.x) * step) / 20;
				const y = from.y + ((to.y - from.y) * step) / 20;
				expect(boxes.some((box) => x > box.l + 1 && x < box.r - 1 && y > box.t + 1 && y < box.b - 1)).toBe(false);
			}
		}
	});

	it('居ない依存は辺にしない', () => {
		const result = runLayout([node({ id: 'a', after: ['消えた'] })]);
		expect(result.edges).toEqual([]);
	});

	it('依存の向きに沿って左から右へ並ぶ', () => {
		const result = runLayout([node({ id: 'a' }), node({ id: 'b', after: ['a'] }), node({ id: 'c', after: ['b'] })]);

		const x = (id: string) => taskOf(result, id)!.position.x;
		expect(x('a')).toBeLessThan(x('b'));
		expect(x('b')).toBeLessThan(x('c'));
	});

	it('子は上限で止まり, 失敗した子が必ず入る', () => {
		const children = Array.from({ length: 40 }, (_unused, i) => child('each', i, i === 39 ? 'FAILED' : 'COMPLETED'));
		const result = runLayout([node({ id: 'each', container: true }), ...children]);

		const chips = result.nodes.filter((n) => n.type === 'child');
		expect(chips).toHaveLength(MAX_CHIPS);
		expect(chips.map((n) => n.id)).toContain('each:39');

		const data = taskOf(result, 'each')!.data as TaskData;
		expect(data.progress).toBe('39 / 40');
		expect(data.summary).toContain(`+${40 - MAX_CHIPS} hidden`);
	});

	it('省略が無ければ内訳は出ない', () => {
		const result = runLayout([node({ id: 'each', container: true }), child('each', 0), child('each', 1)]);
		expect((taskOf(result, 'each')!.data as TaskData).summary).toBeNull();
	});

	it('子は親の箱の中に収まる', () => {
		const children = Array.from({ length: 9 }, (_unused, i) => child('each', i));
		const result = runLayout([node({ id: 'each', container: true, job_id: 'GREET#0:x', error: 'intentional failure' }), ...children]);

		const parent = taskOf(result, 'each')!;
		const width = Number.parseFloat(parent.style.width);
		const height = Number.parseFloat(parent.style.height);
		for (const chip of result.nodes.filter((n) => n.type === 'child')) {
			expect(chip.position.x).toBeGreaterThanOrEqual(0);
			expect(chip.position.y).toBeGreaterThanOrEqual(0);
			expect(chip.position.x + Number.parseFloat(chip.style.width)).toBeLessThanOrEqual(width);
			expect(chip.position.y + Number.parseFloat(chip.style.height)).toBeLessThanOrEqual(height);
		}
	});

	it('孫は描かず件数だけ残す', () => {
		const result = runLayout([
			node({ id: 'each', container: true }),
			child('each', 0),
			node({ id: 'each:0:sub', parent: 'each:0', origin: 'spawn' }),
		]);

		expect(result.nodes.map((n) => n.id)).toEqual(['each', 'each:0']);
		expect((taskOf(result, 'each:0')!.data as ChildData).nested).toBe(1);
	});

	it('同じ入力からは同じ配置が出る', () => {
		const nodes = [node({ id: 'a' }), node({ id: 'b', after: ['a'] }), node({ id: 'c', after: ['a'] })];
		expect(runLayout(nodes)).toEqual(runLayout(nodes));
	});

	it('ノードが無くても例外にならない', () => {
		expect(runLayout([])).toEqual({ nodes: [], edges: [] });
	});

	it('親が消えた子だけでも例外にならない', () => {
		expect(runLayout([child('消えた', 0)])).toEqual({ nodes: [], edges: [] });
	});
});
