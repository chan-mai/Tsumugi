import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXPECTED_MIGRATIONS, migrationErrorMessage } from '../../src/projection/migrations.js';

// workers環境のURL型との衝突回避、文字列で解決
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

describe('マイグレーションの宣言(ADR-0008)', () => {
	it('EXPECTED_MIGRATIONSが実ファイルと一致する', () => {
		// 不一致時は適用漏れ検出不能
		const actual = readdirSync(dir)
			.filter((name) => name.endsWith('.sql'))
			.sort();

		expect(actual.length).toBeGreaterThan(0);
		expect([...EXPECTED_MIGRATIONS]).toEqual(actual);
	});

	it('適用順が名前順と一致する', () => {
		// wranglerは名前順に適用, 宣言順が異なると欠落の報告順が実際と不一致
		expect([...EXPECTED_MIGRATIONS]).toEqual([...EXPECTED_MIGRATIONS].sort());
	});

	it('エラー文に実行すべきコマンドが入る', () => {
		const message = migrationErrorMessage(['0002_add_attempt_log.sql']);
		expect(message).toContain('0002_add_attempt_log.sql');
		expect(message).toContain('wrangler d1 migrations apply');
	});
});
