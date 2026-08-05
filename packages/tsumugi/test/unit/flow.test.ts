import { describe, expect, it } from 'vitest';
import { createFlow, InvalidFlowError, shapeOf } from '../../src/core/flow.js';

// 型の導出だけを見るのでperformの中身は問わない
class Fetch {
	async perform(_payload: { since: number }) {
		return { items: ['a', 'b'] };
	}
}

class Work {
	async perform(_payload: { id: string }) {
		return { ok: true };
	}
}

const flow = createFlow({ FETCH: Fetch, WORK: Work });

describe('flowの組み立て', () => {
	it('afterの受け取り口を依存先のノードIDへ写す', () => {
		const built = flow<{ since: number }>((f) => {
			const fetched = f.node('fetch', 'FETCH', { input: (i) => ({ since: i.since }) });
			f.node('work', 'WORK', { after: { fetched }, input: (_i, d) => ({ id: d.fetched.items[0] as string }) });
		});

		expect(built.nodes.map((n) => n.id)).toEqual(['fetch', 'work']);
		expect(built.nodes[1]?.after).toEqual({ fetched: 'fetch' });
	});

	it('shapeOfは関数を落として形だけ返す(ADR-0030)', () => {
		const built = flow<void>((f) => {
			const fetched = f.node('fetch', 'FETCH', { input: () => ({ since: 0 }) });
			f.fanOut('each', 'WORK', {
				after: { fetched },
				over: (_i, d) => d.fetched.items,
				input: (item) => ({ id: item }),
			});
		});

		const shape = shapeOf(built);
		expect(shape).toEqual([
			{ id: 'fetch', binding: 'FETCH', container: false, after: [] },
			{ id: 'each', binding: 'WORK', container: true, after: ['fetch'] },
		]);
		// JSONへ載せてDOに渡すので関数が混ざっていないこと自体が要件
		expect(JSON.parse(JSON.stringify(shape))).toEqual(shape);
	});

	it('ノードIDの重複を弾く', () => {
		expect(() =>
			flow<void>((f) => {
				f.node('same', 'FETCH', { input: () => ({ since: 0 }) });
				f.node('same', 'FETCH', { input: () => ({ since: 0 }) });
			}),
		).toThrow(InvalidFlowError);
	});

	it('区切り文字を含むノードIDを弾く', () => {
		expect(() => flow<void>((f) => f.node('a:b', 'FETCH', { input: () => ({ since: 0 }) }) as unknown as void)).toThrow(InvalidFlowError);
	});

	it('ノードが1つも無いflowを弾く', () => {
		expect(() => flow<void>(() => {})).toThrow(InvalidFlowError);
	});

	it('deadlineMsを持つflowを組み立てる(ADR-0039)', () => {
		const built = flow<void>((f) => f.node('fetch', 'FETCH', { input: () => ({ since: 0 }) }) as unknown as void, {
			deadlineMs: 60_000,
		});
		expect(built.deadlineMs).toBe(60_000);
	});

	it('未指定のdeadlineMsはプロパティごと持たない', () => {
		const built = flow<void>((f) => f.node('fetch', 'FETCH', { input: () => ({ since: 0 }) }) as unknown as void);
		expect('deadlineMs' in built).toBe(false);
	});

	it('正の整数でないdeadlineMsを弾く', () => {
		for (const deadlineMs of [0, -1, 1.5]) {
			expect(() => flow<void>((f) => f.node('fetch', 'FETCH', { input: () => ({ since: 0 }) }) as unknown as void, { deadlineMs })).toThrow(
				InvalidFlowError,
			);
		}
	});

	it('別のflowのノードへの依存を弾く', () => {
		const other = flow<void>((f) => {
			f.node('outside', 'FETCH', { input: () => ({ since: 0 }) });
		});
		const foreign = { id: other.nodes[0]!.id } as never;

		expect(() =>
			flow<void>((f) => {
				f.node('work', 'WORK', { after: { dep: foreign }, input: () => ({ id: 'x' }) });
			}),
		).toThrow(InvalidFlowError);
	});

	it('同じ依存先を複数の受け取り口で受けても形は重複しない', () => {
		const built = flow<void>((f) => {
			const fetched = f.node('fetch', 'FETCH', { input: () => ({ since: 0 }) });
			f.node('work', 'WORK', {
				after: { first: fetched, second: fetched },
				input: (_i, d) => ({ id: `${d.first.items.length}${d.second.items.length}` }),
			});
		});

		expect(shapeOf(built)[1]?.after).toEqual(['fetch']);
	});

	it('fan-outノードは展開の材料を持つ', () => {
		const built = flow<void>((f) => {
			const fetched = f.node('fetch', 'FETCH', { input: () => ({ since: 0 }) });
			f.fanOut('each', 'WORK', {
				after: { fetched },
				over: (_i, d) => d.fetched.items,
				input: (item, _i, index) => ({ id: `${item}-${index}` }),
				key: (item) => item,
			});
		});

		const container = built.nodes[1];
		expect(container?.container).toBe(true);
		expect(container?.over?.(undefined, { fetched: { items: ['x'] } })).toEqual(['x']);
		expect(container?.item?.('x', undefined, 2)).toEqual({ id: 'x-2' });
		expect(container?.key?.('x', 0)).toBe('x');
	});
});
