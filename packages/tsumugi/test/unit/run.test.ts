import { describe, expect, it } from 'vitest';
import { advance, type NodeState, type NodeView } from '../../src/core/run.js';

type NodeSpec = {
	id: string;
	state: NodeState;
	after?: string[];
	parent?: string;
	origin?: NodeView['origin'];
	container?: boolean;
};

const node = (n: NodeSpec): NodeView => ({
	id: n.id,
	state: n.state,
	container: n.container ?? false,
	parent: n.parent ?? null,
	origin: n.origin ?? 'static',
	after: n.after ?? [],
});

const ids = (nodes: NodeView[], type: string) =>
	advance({ nodes, cancelling: false })
		.decisions.filter((d) => d.type === type)
		.map((d) => d.id);

describe('runの進行判断', () => {
	it('依存の無いノードだけを起動する', () => {
		const nodes = [node({ id: 'a', state: 'PENDING' }), node({ id: 'b', state: 'PENDING', after: ['a'] })];
		expect(ids(nodes, 'start')).toEqual(['a']);
	});

	it('依存が成功したら次を起動する', () => {
		const nodes = [node({ id: 'a', state: 'COMPLETED' }), node({ id: 'b', state: 'PENDING', after: ['a'] })];
		expect(ids(nodes, 'start')).toEqual(['b']);
	});

	it('依存が失敗したら下流を打ち切る', () => {
		const nodes = [node({ id: 'a', state: 'FAILED' }), node({ id: 'b', state: 'PENDING', after: ['a'] })];
		expect(ids(nodes, 'skip')).toEqual(['b']);
	});

	it('独立した枝は失敗の影響を受けない', () => {
		const nodes = [
			node({ id: 'a', state: 'FAILED' }),
			node({ id: 'b', state: 'PENDING', after: ['a'] }),
			node({ id: 'x', state: 'PENDING' }),
		];
		const output = advance({ nodes, cancelling: false });
		expect(output.decisions).toEqual([
			{ type: 'skip', id: 'b' },
			{ type: 'start', id: 'x' },
		]);
	});

	it('合流は全ての依存が決着するまで待つ', () => {
		const nodes = [
			node({ id: 'a', state: 'COMPLETED' }),
			node({ id: 'b', state: 'RUNNING' }),
			node({ id: 'c', state: 'PENDING', after: ['a', 'b'] }),
		];
		expect(advance({ nodes, cancelling: false }).decisions).toEqual([]);
	});

	it('親は子孫が終わるまで決着しない(ADR-0032)', () => {
		const nodes = [
			node({ id: 'a', state: 'COMPLETED' }),
			node({ id: 'a:1', state: 'RUNNING', parent: 'a', origin: 'spawn' }),
			node({ id: 'b', state: 'PENDING', after: ['a'] }),
		];
		expect(advance({ nodes, cancelling: false }).decisions).toEqual([]);

		const done = [
			node({ id: 'a', state: 'COMPLETED' }),
			node({ id: 'a:1', state: 'COMPLETED', parent: 'a', origin: 'spawn' }),
			node({ id: 'b', state: 'PENDING', after: ['a'] }),
		];
		expect(ids(done, 'start')).toEqual(['b']);
	});

	it('spawnした子の失敗は親の失敗として下流を止める', () => {
		const nodes = [
			node({ id: 'a', state: 'COMPLETED' }),
			node({ id: 'a:1', state: 'FAILED', parent: 'a', origin: 'spawn' }),
			node({ id: 'b', state: 'PENDING', after: ['a'] }),
		];
		expect(ids(nodes, 'skip')).toEqual(['b']);
	});

	it('fan-outの子の失敗は要約で渡すので下流を止めない(ADR-0035)', () => {
		const nodes = [
			node({ id: 'each', state: 'COMPLETED', container: true }),
			node({ id: 'each:0', state: 'COMPLETED', parent: 'each', origin: 'fanOut' }),
			node({ id: 'each:1', state: 'FAILED', parent: 'each', origin: 'fanOut' }),
			node({ id: 'b', state: 'PENDING', after: ['each'] }),
		];
		expect(ids(nodes, 'start')).toEqual(['b']);
	});

	it('fan-outノードは起動ではなく展開を求める', () => {
		const nodes = [node({ id: 'each', state: 'PENDING', container: true })];
		expect(advance({ nodes, cancelling: false }).decisions).toEqual([{ type: 'expand', id: 'each' }]);
	});

	it('fan-outノードは子が全て終端に達した時点で集約する', () => {
		const nodes = [
			node({ id: 'each', state: 'RUNNING', container: true }),
			node({ id: 'each:0', state: 'COMPLETED', parent: 'each', origin: 'fanOut' }),
		];
		expect(advance({ nodes, cancelling: false }).decisions).toEqual([{ type: 'aggregate', id: 'each' }]);
	});

	it('子が残っているfan-outノードは集約しない', () => {
		const nodes = [
			node({ id: 'each', state: 'RUNNING', container: true }),
			node({ id: 'each:0', state: 'RUNNING', parent: 'each', origin: 'fanOut' }),
		];
		expect(advance({ nodes, cancelling: false }).decisions).toEqual([]);
	});

	it('取り消しは未起動とSCHEDULEDにだけ出す(ADR-0012)', () => {
		const nodes = [
			node({ id: 'a', state: 'PENDING' }),
			node({ id: 'b', state: 'SCHEDULED' }),
			node({ id: 'c', state: 'RUNNING' }),
			node({ id: 'd', state: 'COMPLETED' }),
		];
		expect(advance({ nodes, cancelling: true }).decisions).toEqual([
			{ type: 'cancel', id: 'a' },
			{ type: 'cancel', id: 'b' },
		]);
	});

	it('取り消し中もfan-outノードを集約する', () => {
		// 集約しないと子孫が終わってもRUNNINGのまま残り, runがCANCELLEDに決着しない
		const nodes = [
			node({ id: 'each', state: 'RUNNING', container: true }),
			node({ id: 'each:0', state: 'COMPLETED', parent: 'each', origin: 'fanOut' }),
		];
		const output = advance({ nodes, cancelling: true });
		expect(output.decisions).toEqual([{ type: 'aggregate', id: 'each' }]);
		expect(output.state).toBe('RUNNING');
	});

	it('依存が消えていれば待たずに打ち切る(ADR-0030)', () => {
		// 定義から消えたノードは決着しないので, 待つと永久にRUNNINGのまま残る
		const nodes = [node({ id: 'b', state: 'PENDING', after: ['gone'] })];
		expect(advance({ nodes, cancelling: false }).decisions).toEqual([{ type: 'skip', id: 'b' }]);
	});

	it('依存の一部が消えていても残りの決着を待たない', () => {
		const nodes = [node({ id: 'a', state: 'RUNNING' }), node({ id: 'b', state: 'PENDING', after: ['a', 'gone'] })];
		expect(advance({ nodes, cancelling: false }).decisions).toEqual([{ type: 'skip', id: 'b' }]);
	});
});

describe('runの状態', () => {
	const stateOf = (nodes: NodeView[], cancelling = false) => advance({ nodes, cancelling }).state;

	it('未決着のノードが1つでもあればRUNNING', () => {
		expect(stateOf([node({ id: 'a', state: 'COMPLETED' }), node({ id: 'b', state: 'PENDING' })])).toBe('RUNNING');
	});

	it('全て成功でCOMPLETED', () => {
		expect(stateOf([node({ id: 'a', state: 'COMPLETED' })])).toBe('COMPLETED');
	});

	it('打ち切りが残ればFAILED', () => {
		expect(stateOf([node({ id: 'a', state: 'FAILED' }), node({ id: 'b', state: 'SKIPPED' })])).toBe('FAILED');
	});

	it('fan-outの子の失敗だけならCOMPLETED(ADR-0035)', () => {
		const nodes = [
			node({ id: 'each', state: 'COMPLETED', container: true }),
			node({ id: 'each:0', state: 'FAILED', parent: 'each', origin: 'fanOut' }),
		];
		expect(stateOf(nodes)).toBe('COMPLETED');
	});

	it('取り消し中でも実行中が残る間はRUNNING', () => {
		expect(stateOf([node({ id: 'a', state: 'RUNNING' })], true)).toBe('RUNNING');
	});

	it('取り消しは全て終端になった時点でCANCELLED', () => {
		expect(stateOf([node({ id: 'a', state: 'CANCELLED' })], true)).toBe('CANCELLED');
	});
});
