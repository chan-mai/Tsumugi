import { describe, expect, it } from 'vitest';
import { validateStartRun } from '../../src/api/validate.js';

describe('開始内容の検証', () => {
	it('登録一覧が無ければ開始先を検証しない', () => {
		expect(validateStartRun({ flow: 'ANY', input: {} }, undefined)).toHaveProperty('input');
	});

	it('登録一覧が空なら何も受け付けない', () => {
		expect(validateStartRun({ flow: 'ANY', input: {} }, [])).toEqual({ error: 'unknown flow: ANY' });
	});

	it('登録一覧にあるflowを受け付ける', () => {
		expect(validateStartRun({ flow: 'GREETINGS', input: {} }, ['GREETINGS'])).toHaveProperty('input');
	});
});
