import { describe, expect, it } from 'vitest';
import { formatJobId, parseJobId } from '../../src/core/ids.js';
import { createLocalId } from '../../src/do/local-id.js';

describe('localIdの生成', () => {
	const ids = Array.from({ length: 1000 }, () => createLocalId());

	it('先頭英小文字の24文字', () => {
		for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9]{23}$/);
	});

	it('ジョブIDとして往復する', () => {
		for (const id of ids.slice(0, 10)) {
			const address = { binding: 'MAIL', shard: 0, localId: id };
			expect(parseJobId(formatJobId(address))).toEqual(address);
		}
	});

	it('重複しない', () => {
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('2文字目以降に全文字種が出現する', () => {
		const seen = new Set(ids.flatMap((id) => [...id.slice(1)]));
		expect(seen.size).toBe(36);
	});
});
