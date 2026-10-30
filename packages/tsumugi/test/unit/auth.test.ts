import { describe, expect, it } from 'vitest';
import { bearerAuth } from '../../src/api/auth.js';

// base64のsecretに含まれる文字, ダッシュボードはencodeURIComponent後にcookieへ保存
const TOKEN = 'sk+ab/cd=';

// 認証成功は200扱い
const get = async (token: string, headers: Record<string, string>) => {
	const rejected = await bearerAuth(token, { cookie: 'tsumugi_token' })(new Request('https://example.com/api/ping', { headers }), {});
	return { status: rejected?.status ?? 200 };
};

describe('bearerAuth', () => {
	it('Authorizationヘッダを受け付ける', async () => {
		expect((await get(TOKEN, { authorization: `Bearer ${TOKEN}` })).status).toBe(200);
	});

	it('URLエンコード済みのcookieを受け付ける', async () => {
		const cookie = `tsumugi_token=${encodeURIComponent(TOKEN)}`;
		expect((await get(TOKEN, { cookie })).status).toBe(200);
	});

	it('エンコード不要なトークンのcookieを受け付ける', async () => {
		expect((await get('plain-token', { cookie: 'tsumugi_token=plain-token' })).status).toBe(200);
	});

	it('不正な%列のcookieは401', async () => {
		expect((await get(TOKEN, { cookie: 'tsumugi_token=%E0%A4%A' })).status).toBe(401);
	});

	it('他のcookieが並んでいても読み取る', async () => {
		const cookie = `other=1; tsumugi_token=${encodeURIComponent(TOKEN)}; last=2`;
		expect((await get(TOKEN, { cookie })).status).toBe(200);
	});

	it('cookieもヘッダも無ければ401', async () => {
		expect((await get(TOKEN, {})).status).toBe(401);
	});
});
