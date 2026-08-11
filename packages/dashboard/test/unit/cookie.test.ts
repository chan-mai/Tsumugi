import { describe, expect, it } from 'vitest';
import { cookieAttributes } from '../../src/api';

describe('トークンcookieの属性', () => {
	it('httpsではSecureを付ける', () => {
		expect(cookieAttributes('https:')).toBe('path=/; SameSite=Strict; Secure');
	});

	it('httpでは付けない', () => {
		// wrangler devはhttpで動くので, 付けるとブラウザが保存しない
		expect(cookieAttributes('http:')).toBe('path=/; SameSite=Strict');
	});
});
