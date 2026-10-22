import { describe, expect, it } from 'vitest';
import { cookieAttributes } from '../../src/api';

describe('トークンcookieの属性', () => {
	it('httpsではSecureを付ける', () => {
		expect(cookieAttributes('https:')).toBe('path=/; SameSite=Strict; Secure');
	});

	it('httpでは付けない', () => {
		// http動作のwrangler devでは付与時に保存失敗
		expect(cookieAttributes('http:')).toBe('path=/; SameSite=Strict');
	});
});
