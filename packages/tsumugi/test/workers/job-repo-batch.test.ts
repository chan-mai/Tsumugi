import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { JobRepo } from '../../src/do/repo.js';

/**
 * キー別バケットの一括処理がバインド変数の上限に収まること(ADR-0045)
 *
 * 対象キーはtickの投入候補から決まり、最大TICK_LIMIT件
 * 1文の変数は100個までで、分割なしでは101キー目でSQLITE_ERROR
 */

const shard = (name: string) => env.JOB_SHARD.get(env.JOB_SHARD.idFromName(name));

const keys = Array.from({ length: 120 }, (_, i) => `k${i}`);

describe('キー別バケットの分割', () => {
	it('上限を超える件数のキーを読める', async () => {
		const size = await runInDurableObject(shard('BUCKET:read'), (instance) => {
			const repo = (instance as unknown as { repo: JobRepo }).repo;
			repo.writeKeyBuckets(Object.fromEntries(keys.map((k) => [k, { tokens: 1, refilledAt: 1 }])));
			return Object.keys(repo.readKeyBuckets(keys)).length;
		});
		expect(size).toBe(120);
	});

	it('`__proto__`のキーが読める', async () => {
		const read = await runInDurableObject(shard('BUCKET:proto'), (instance) => {
			const repo = (instance as unknown as { repo: JobRepo }).repo;
			repo.writeKeyBuckets(Object.fromEntries([['__proto__', { tokens: 1, refilledAt: 1 }]]));
			const buckets = repo.readKeyBuckets(['__proto__']);
			return { own: Object.hasOwn(buckets, '__proto__'), keys: Object.keys(buckets) };
		});
		expect(read).toEqual({ own: true, keys: ['__proto__'] });
	});

	it('上限を超える件数のキーを削除できる', async () => {
		const size = await runInDurableObject(shard('BUCKET:delete'), (instance) => {
			const repo = (instance as unknown as { repo: JobRepo }).repo;
			repo.writeKeyBuckets(Object.fromEntries(keys.map((k) => [k, { tokens: 1, refilledAt: 1 }])));
			repo.deleteKeyBuckets(keys);
			return Object.keys(repo.readKeyBuckets(keys)).length;
		});
		expect(size).toBe(0);
	});
});
