import { describe, expect, it } from 'vitest';
import type { PerformerLike } from '../../src/core/api.js';
import { createFlow } from '../../src/core/flow.js';
import { simulateFlow } from '../../src/testing/flow.js';

// `createFlow`はctorのインスタンス型からpayloadと戻り値を導出し、実体は呼ばれない
// `Performer`は`cloudflare:workers`に依存し, workerdを起動しないこのプロジェクトでは読めない
type Ctor<P, R> = new (...args: any[]) => PerformerLike<P, R>;

const performers = {
	LIST: class {} as Ctor<{ prefix: string }, { names: string[] }>,
	GREET: class {} as Ctor<{ name: string }, { greeted: string }>,
	REPORT: class {} as Ctor<{ total: number; failed: number }, void>,
};

const flow = createFlow(performers);

/** exampleと同じ形, 一覧を取り件数だけ実行時に決まる並列で挨拶し最後に要約 */
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

const stateOf = (result: { nodes: { id: string; state: string }[] }, id: string) => result.nodes.find((node) => node.id === id)?.state;

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

	it('失敗時の後処理が実行され成功時は実行されない(ADR-0041)', () => {
		const withCleanup = flow<void>((f) => {
			const list = f.node('list', 'LIST', { input: () => ({ prefix: '' }) });
			f.node('cleanup', 'REPORT', {
				after: { list },
				trigger: 'failure',
				input: () => ({ total: 0, failed: 1 }),
			});
			f.node('done', 'REPORT', { after: { list }, input: () => ({ total: 1, failed: 0 }) });
		});

		const failed = simulateFlow(withCleanup, undefined, { fails: ['list'] });
		expect(stateOf(failed, 'cleanup')).toBe('COMPLETED');
		expect(stateOf(failed, 'done')).toBe('SKIPPED');
		// 後始末が成功してもrunは失敗のまま
		expect(failed.state).toBe('FAILED');

		const ok = simulateFlow(withCleanup, undefined, { results: { list: { names: [] } } });
		expect(stateOf(ok, 'cleanup')).toBe('SKIPPED');
		expect(stateOf(ok, 'done')).toBe('COMPLETED');
		expect(ok.state).toBe('COMPLETED');
	});

	it('alwaysは成否を問わず通る', () => {
		const withAlways = flow<void>((f) => {
			const list = f.node('list', 'LIST', { input: () => ({ prefix: '' }) });
			f.node('always', 'REPORT', { after: { list }, trigger: 'always', input: () => ({ total: 0, failed: 0 }) });
		});

		expect(stateOf(simulateFlow(withAlways, undefined, { fails: ['list'] }), 'always')).toBe('COMPLETED');
		expect(stateOf(simulateFlow(withAlways, undefined, { results: { list: { names: [] } } }), 'always')).toBe('COMPLETED');
	});

	it('whenが経路を選ぶ(ADR-0041)', () => {
		const branched = flow<{ big: boolean }>((f) => {
			const list = f.node('list', 'LIST', { input: () => ({ prefix: '' }) });
			f.node('heavy', 'REPORT', {
				after: { list },
				when: (i, d) => i.big && d.list.names.length > 1,
				input: () => ({ total: 2, failed: 0 }),
			});
			f.node('light', 'REPORT', {
				after: { list },
				when: (i) => !i.big,
				input: () => ({ total: 1, failed: 0 }),
			});
		});

		const results = { list: { names: ['a', 'b'] } };
		const big = simulateFlow(branched, { big: true }, { results });
		expect(stateOf(big, 'heavy')).toBe('COMPLETED');
		expect(stateOf(big, 'light')).toBe('SKIPPED');

		const small = simulateFlow(branched, { big: false }, { results });
		expect(stateOf(small, 'heavy')).toBe('SKIPPED');
		expect(stateOf(small, 'light')).toBe('COMPLETED');
	});

	it('whenの例外はノードをFAILEDにする(ADR-0041)', () => {
		const broken = flow<void>((f) => {
			const list = f.node('list', 'LIST', { input: () => ({ prefix: '' }) });
			f.node('boom', 'REPORT', {
				after: { list },
				when: () => {
					throw new Error('cannot decide');
				},
				input: () => ({ total: 0, failed: 0 }),
			});
			// 失敗しても後始末は通る
			f.node('always', 'REPORT', { after: { list }, trigger: 'always', input: () => ({ total: 0, failed: 0 }) });
		});

		const result = simulateFlow(broken, undefined, { results: { list: { names: [] } } });
		expect(stateOf(result, 'boom')).toBe('FAILED');
		expect(stateOf(result, 'always')).toBe('COMPLETED');
		expect(result.state).toBe('FAILED');
	});

	it('SKIPPEDの依存では後始末が通らない(ADR-0041)', () => {
		const branched = flow<void>((f) => {
			const list = f.node('list', 'LIST', { input: () => ({ prefix: '' }) });
			const gated = f.node('gated', 'REPORT', { after: { list }, when: () => false, input: () => ({ total: 0, failed: 0 }) });
			f.node('cleanup', 'REPORT', { after: { gated }, trigger: 'failure', input: () => ({ total: 0, failed: 1 }) });
		});

		const result = simulateFlow(branched, undefined, { results: { list: { names: [] } } });
		expect(stateOf(result, 'gated')).toBe('SKIPPED');
		// 経路を選ばなかっただけなので後始末は要らない
		expect(stateOf(result, 'cleanup')).toBe('SKIPPED');
		expect(result.state).toBe('COMPLETED');
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
