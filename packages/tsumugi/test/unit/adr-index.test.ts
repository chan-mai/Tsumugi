import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const decisionDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'docs', 'decision');

describe('ADR索引の網羅', () => {
	it('実在するADRが全て索引に載っている', () => {
		// 索引が手書きなので, 追加時に載せ忘れるとコードの参照先が辿れなくなる
		const files = readdirSync(decisionDir)
			.filter((name) => /^\d{4}-.+\.md$/.test(name))
			.sort();
		const index = readFileSync(join(decisionDir, 'README.md'), 'utf8');

		const missing = files.filter((name) => !index.includes(`(${name})`));
		expect(missing).toEqual([]);
	});

	it('索引の番号が連番で欠番がない', () => {
		const numbers = readdirSync(decisionDir)
			.map((name) => /^(\d{4})-/.exec(name)?.[1])
			.filter((n): n is string => n !== undefined)
			.map(Number)
			.sort((a, b) => a - b);

		expect(numbers[0]).toBe(1);
		for (let i = 1; i < numbers.length; i++) {
			expect(numbers[i], `ADR-${String(numbers[i]).padStart(4, '0')}の手前で欠番`).toBe(numbers[i - 1]! + 1);
		}
	});
});
