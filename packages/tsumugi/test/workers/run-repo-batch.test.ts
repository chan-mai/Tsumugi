import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { RunRepo } from '../../src/do/run-repo.js';
import type { TsumugiRunInstance } from '../../src/do/run.js';

// 1文のバインド変数上限100, 超過でSQLITE_ERROR
// fan-out展開, tick変更ノード追記は件数が実行時確定

const ns = env.RUN as unknown as DurableObjectNamespace<TsumugiRunInstance>;

const repoOf = (instance: unknown) => (instance as { repo: RunRepo }).repo;

const newNodes = (count: number) =>
	Array.from({ length: count }, (_, i) => ({
		id: `n${i}`,
		binding: 'GREET',
		container: false,
		parent: null,
		origin: 'static' as const,
		after: [],
		seq: i,
	}));

describe('一括の書き込みの分割', () => {
	it('上限を超える件数のノードを作れる', async () => {
		const stub = ns.get(ns.idFromName('BATCH:insert'));
		const count = await runInDurableObject(stub, instance => {
			const repo = repoOf(instance);
			repo.insertNodes(newNodes(120), 1);
			return repo.countNodes();
		});
		expect(count).toBe(120);
	});

	it('上限を超える件数のノードを投影へ積める', async () => {
		const stub = ns.get(ns.idFromName('BATCH:outbox'));
		const appended = await runInDurableObject(stub, instance => {
			const repo = repoOf(instance);
			const nodes = newNodes(120);
			repo.insertNodes(nodes, 1);
			repo.appendNodeOutbox(
				'BATCH:outbox',
				nodes.map(n => n.id),
			);
			return repo.outboxBatch(200).length;
		});
		expect(appended).toBe(120);
	});

	it('上限を超える件数の依存の戻り値を引ける', async () => {
		const stub = ns.get(ns.idFromName('BATCH:results'));
		const size = await runInDurableObject(stub, instance => {
			const repo = repoOf(instance);
			const nodes = newNodes(120);
			repo.insertNodes(nodes, 1);
			for (const n of nodes) repo.updateNode(n.id, { result: JSON.stringify({ id: n.id }) }, 1);
			return repo.resultsOf(nodes.map(n => n.id)).size;
		});
		expect(size).toBe(120);
	});
});
