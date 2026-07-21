import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXPECTED_MIGRATIONS, migrationErrorMessage } from '../../src/projection/migrations.js';

// workers環境のURL型と衝突するので, URLオブジェクトを経由せず文字列で解決する
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

describe('マイグレーションの宣言(ADR-0008)', () => {
	it('EXPECTED_MIGRATIONSが実ファイルと一致する', () => {
		// ずれると検査が素通りし,適用漏れを検出できなくなる
		const actual = readdirSync(dir)
			.filter((name) => name.endsWith('.sql'))
			.sort();

		expect(actual.length).toBeGreaterThan(0);
		expect([...EXPECTED_MIGRATIONS]).toEqual(actual);
	});

	it('適用順が名前順と一致する', () => {
		// wranglerは名前順に適用する, 宣言の並びが違うと欠落の報告順が実際とずれる
		expect([...EXPECTED_MIGRATIONS]).toEqual([...EXPECTED_MIGRATIONS].sort());
	});

	it('エラー文に実行すべきコマンドが入る', () => {
		const message = migrationErrorMessage(['0002_add_attempt_log.sql']);
		expect(message).toContain('0002_add_attempt_log.sql');
		expect(message).toContain('wrangler d1 migrations apply');
	});
});
