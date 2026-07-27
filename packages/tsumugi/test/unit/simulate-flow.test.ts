import { describe, expect, it } from 'vitest';
import { Performer } from '../../src/core/api.js';
import { createFlow } from '../../src/core/flow.js';
import { simulateFlow } from '../../src/testing/flow.js';

class ListNames extends Performer<{ prefix: string }, { names: string[] }> {
	async perform() {
		return { names: [] as string[] };
	}
}

class Greet extends Performer<{ name: string }, { greeted: string }> {
	async perform() {
		return { greeted: '' };
	}
}

class Report extends Performer<{ total: number; failed: number }, void> {
	async perform() {}
}

const flow = createFlow({ LIST: ListNames, GREET: Greet, REPORT: Report });

/** exampleと同じ形, 一覧を取り件数だけ実行時に決まる並列で挨拶し最後に要約する */
const greetings = flow<{ prefix: string }>((f) => {
	const list = f.node('list', 'LIST', { input: (i) => ({ prefix: i.prefix }) });
	const each = f.fanOut('greet', 'GREET', {
		after: { list },
		over: (_i, d) => d.list.names,
		input: (name) => ({ name }),
	});
	f.node('report', 'REPORT', {
		after: { each },
		input: (_i, d) => ({ total: d.each.total, failed: d.each.failed }),
	});
});

const ids = (result: ReturnType<typeof simulateFlow>) => result.nodes.map((node) => node.id);

describe('flowの通し実行', () => {
	it('依存の順にノードを実行する', () => {
		const result = simulateFlow(greetings, { prefix: 'hello' }, { results: { list: { names: ['a', 'b'] } } });

		expect(ids(result)).toEqual(['list', 'greet:0', 'greet:1', 'greet', 'report']);
		expect(result.state).toBe('COMPLETED');
	});

	it('各ノードへ渡るpayloadを返す', () => {
		const result = simulateFlow(greetings, { prefix: 'hello' }, { results: { list: { names: ['a', 'b'] } } });
		const payloads = Object.fromEntries(result.nodes.map((node) => [node.id, node.payload]));

		expect(payloads.list).toEqual({ prefix: 'hello' });
		expect(payloads['greet:0']).toEqual({ name: 'a' });
		expect(payloads['greet:1']).toEqual({ name: 'b' });
		// fan-outノードの集計値が後段の材料になる(ADR-0035)
		expect(payloads.report).toEqual({ total: 2, failed: 0 });
	});

	it('fan-outの件数がoverの結果で決まる', () => {
		const result = simulateFlow(greetings, { prefix: 'x' }, { results: { list: { names: ['a', 'b', 'c', 'd'] } } });
		expect(result.nodes.filter((node) => node.parent === 'greet')).toHaveLength(4);
	});

	it('子が0件でも後段へ進む', () => {
		const result = simulateFlow(greetings, { prefix: 'x' }, { results: { list: { names: [] } } });

		expect(ids(result)).toEqual(['list', 'greet', 'report']);
		expect(result.nodes.find((node) => node.id === 'report')?.payload).toEqual({ total: 0, failed: 0 });
	});

	it('fan-outの子の失敗は要約に載り後段は進む', () => {
		const result = simulateFlow(greetings, { prefix: 'x' }, { results: { list: { names: ['a', 'b'] } }, fails: ['greet:1'] });

		expect(result.nodes.find((node) => node.id === 'report')?.payload).toEqual({ total: 2, failed: 1 });
		expect(result.state).toBe('COMPLETED');
	});

	it('失敗したノードの下流をSKIPPEDにする', () => {
		const result = simulateFlow(greetings, { prefix: 'x' }, { fails: ['list'] });
		const states = Object.fromEntries(result.nodes.map((node) => [node.id, node.state]));

		expect(states.list).toBe('FAILED');
		expect(states.greet).toBe('SKIPPED');
		expect(states.report).toBe('SKIPPED');
		expect(result.state).toBe('FAILED');
	});

	it('結果を関数で与えられる', () => {
		const result = simulateFlow(greetings, { prefix: 'p' }, { results: (node) => (node.id === 'list' ? { names: ['z'] } : undefined) });
		expect(result.nodes.find((node) => node.id === 'greet:0')?.payload).toEqual({ name: 'z' });
	});

	it('子ノードIDの決め方をkeyで変えられる', () => {
		const keyed = flow<void>((f) => {
			const list = f.node('list', 'LIST', { input: () => ({ prefix: '' }) });
			f.fanOut('greet', 'GREET', {
				after: { list },
				over: (_i, d) => d.list.names,
				input: (name) => ({ name }),
				key: (name) => name,
			});
		});

		const result = simulateFlow(keyed, undefined, { results: { list: { names: ['alice', 'bob'] } } });
		expect(ids(result)).toEqual(['list', 'greet:alice', 'greet:bob', 'greet']);
	});
});
