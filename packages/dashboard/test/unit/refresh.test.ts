import { describe, expect, it } from 'vitest';
import { DEFAULT_REFRESH_MS, loadRefresh, REFRESH_KEY, REFRESH_OPTIONS } from '../../src/refresh';

const storage = (value: string | null) => ({ getItem: () => value });

describe('更新間隔の読み出し', () => {
	it('保存が無ければ既定を使う', () => {
		expect(loadRefresh(storage(null))).toBe(DEFAULT_REFRESH_MS);
	});

	it('選択肢の値をそのまま使う', () => {
		for (const option of REFRESH_OPTIONS) {
			expect(loadRefresh(storage(String(option.ms)))).toBe(option.ms);
		}
	});

	it('選択肢に無い値は既定へ落とす', () => {
		// 手で書き換えられた場合や, 選択肢を減らした後の値が残っている場合
		for (const raw of ['500', 'live', '', '-1']) {
			expect(loadRefresh(storage(raw))).toBe(DEFAULT_REFRESH_MS);
		}
	});

	it('自動更新なしを選べる', () => {
		expect(loadRefresh(storage('0'))).toBe(0);
	});

	it('保存先の名前が列の設定と衝突しない', () => {
		expect(REFRESH_KEY).not.toBe('tsumugi:columns');
	});
});
