import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { bearerAuth } from '../../src/api/auth.js';
import type { RestEnv } from '../../src/api/rest.js';
import { Performer } from '../../src/core/api.js';
import { clearUiCache, ui } from '../../src/ui/serve.js';
import { defineTsumugi } from '../../src/worker.js';

const TOKEN = 'ui-token';

class Noop extends Performer<unknown, void, {}, RestEnv> {
	async perform(): Promise<void> {}
}

const handler = (options: { auth?: boolean; basePath?: string } = {}) =>
	defineTsumugi({
		performers: { UI: Noop },
		...(options.auth === false ? {} : { auth: bearerAuth(TOKEN) }),
		ui: ui(options.basePath === undefined ? {} : { basePath: options.basePath }),
	});

const call = (h: ReturnType<typeof handler>, path: string, headers: Record<string, string> = {}) =>
	h.fetch!(
		new Request(`https://example.com${path}`, { headers }),
		env as RestEnv,
		{
			waitUntil: () => {},
			passThroughOnException: () => {},
		} as unknown as ExecutionContext,
	);

const authorized = { authorization: `Bearer ${TOKEN}` };

beforeEach(() => clearUiCache());

describe('ダッシュボードの配信(ADR-0025)', () => {
	it('ルートでHTMLが返る', async () => {
		const res = await call(handler(), '/', authorized);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/html');
		const html = await res.text();
		expect(html).toContain('<!doctype html>');
		expect(html).toContain('Tsumugi');
	});

	it('JSとCSSがインライン化されている', async () => {
		const html = await (await call(handler(), '/', authorized)).text();
		// 外部参照が残っているとStatic Assetsに依存することになる
		expect(html).not.toMatch(/<script[^>]+src=/);
		expect(html).not.toMatch(/<link[^>]+stylesheet/);
	});

	it('マウントパスを配信時に注入する', async () => {
		const html = await (await call(handler({ basePath: '/admin' }), '/admin', authorized)).text();
		expect(html).toContain('"base":"/admin"');
	});

	it('末尾のスラッシュは落とす', async () => {
		expect(ui({ basePath: '/admin/' }).basePath).toBe('/admin');
	});

	it('注入済みHTMLを使い回す', () => {
		const dashboard = ui({ basePath: '/x' });
		// リクエストごとに数十KBの置換をしない
		expect(dashboard.render()).toBe(dashboard.render());
	});

	it('APIのルートはSPAに奪われない', async () => {
		const res = await call(handler(), '/api/stats', authorized);
		expect(res.headers.get('content-type')).toContain('application/json');
	});

	it('認証が無くてもHTMLの殻は返る', async () => {
		// データを含まないのでトークン入力を出すために開ける(ADR-0013)
		const res = await call(handler(), '/');
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('<!doctype html>');
	});

	it('殻を開けてもAPIは保護される', async () => {
		expect((await call(handler(), '/api/jobs')).status).toBe(401);
		expect((await call(handler(), '/api/stats')).status).toBe(401);
	});

	it('tokenCookieを注入する', async () => {
		const h = defineTsumugi({
			performers: { UI: Noop },
			auth: bearerAuth(TOKEN),
			ui: ui({ tokenCookie: 'tsumugi_token' }),
		});
		const html = await (await call(h, '/')).text();
		expect(html).toContain('"tokenCookie":"tsumugi_token"');
	});

	it('tokenCookie未指定ならnullを注入する', async () => {
		const html = await (await call(handler(), '/')).text();
		expect(html).toContain('"tokenCookie":null');
	});

	it('認証未設定なら404でHTMLも出さない', async () => {
		// fail-closed,ダッシュボードの存在自体を明かさない(ADR-0013)
		const res = await call(handler({ auth: false }), '/');
		expect(res.status).toBe(404);
		expect(await res.text()).not.toContain('<!doctype html>');
	});
});
