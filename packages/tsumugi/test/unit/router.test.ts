import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRouter } from '../../src/api/router.js';

function appWith(options: { fallback?: boolean } = {}) {
	const passed: string[] = [];
	const app = createRouter<{}>();
	app.use('/api/*', (c) => {
		passed.push(new URL(c.req.url).pathname);
		return undefined;
	});
	app.get('/api/jobs', (c) => c.json({ jobs: [] }));
	app.get('/api/jobs/:id', (c) => c.json({ id: c.req.param('id') }));
	app.post('/api/jobs/:id/retry', (c) => c.json({ id: c.req.param('id') }, 201));
	app.post('/api/boom', () => {
		throw new Error('boom');
	});
	if (options.fallback) app.get('*', (c) => c.html('<html></html>'));
	return { app, passed };
}

const send = (app: ReturnType<typeof appWith>['app'], method: string, path: string) =>
	app.fetch(new Request(`https://example.com${path}`, { method }), {});

describe('ルーティング', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('パスパラメータをデコードする', async () => {
		const { app } = appWith();
		expect(await (await send(app, 'GET', '/api/jobs/REST%230%3Aabc')).json()).toEqual({ id: 'REST#0:abc' });
		expect(await (await send(app, 'POST', '/api/jobs/a%2Fb/retry')).json()).toEqual({ id: 'a/b' });
	});

	it('デコード不能なパラメータは元の値', async () => {
		const { app } = appWith();
		expect(await (await send(app, 'GET', '/api/jobs/%E0%A4%A')).json()).toEqual({ id: '%E0%A4%A' });
	});

	it('json応答の状態コードとContent-Type', async () => {
		const { app } = appWith();
		const res = await send(app, 'POST', '/api/jobs/x/retry');
		expect(res.status).toBe(201);
		expect(res.headers.get('content-type')).toBe('application/json');
	});

	it('未登録の経路とメソッドは404', async () => {
		const { app } = appWith();
		for (const [method, path] of [
			['GET', '/api/unknown'],
			['PUT', '/api/jobs'],
			['GET', '/api/jobs/'],
		] as const) {
			const res = await send(app, method, path);
			expect(res.status).toBe(404);
			expect(await res.text()).toBe('404 Not Found');
		}
	});

	it('HEADはGETの経路で本文なし', async () => {
		const { app } = appWith();
		const res = await send(app, 'HEAD', '/api/jobs');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/json');
		expect(await res.text()).toBe('');
	});

	it('例外は500', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { app } = appWith();
		const res = await send(app, 'POST', '/api/boom');
		expect(res.status).toBe(500);
		expect(await res.text()).toBe('Internal Server Error');
		expect(logged).toHaveBeenCalledOnce();
	});

	it('前処理は`/api`自体と配下に適用', async () => {
		const { app, passed } = appWith();
		await send(app, 'GET', '/api');
		await send(app, 'GET', '/api/jobs');
		await send(app, 'GET', '/other');
		expect(passed).toEqual(['/api', '/api/jobs']);
	});

	it('前処理のResponseで後続を中断', async () => {
		const app = createRouter<{}>();
		const reached = vi.fn();
		app.use('/api/*', (c) => c.json({ error: 'unauthorized' }, 401));
		app.get('/api/jobs', (c) => {
			reached();
			return c.json({});
		});
		expect((await app.fetch(new Request('https://example.com/api/jobs'), {})).status).toBe(401);
		expect(reached).not.toHaveBeenCalled();
	});

	it('`*`は未一致のGETのみ処理', async () => {
		const { app } = appWith({ fallback: true });
		const page = await send(app, 'GET', '/api/unknown');
		expect(page.headers.get('content-type')).toBe('text/html; charset=UTF-8');
		expect(await page.text()).toBe('<html></html>');
		expect((await send(app, 'POST', '/api/unknown')).status).toBe(404);
	});

	it('登録経路の一覧は前処理を含まない', () => {
		const { app } = appWith({ fallback: true });
		expect(app.routes).toEqual([
			{ method: 'GET', path: '/api/jobs' },
			{ method: 'GET', path: '/api/jobs/:id' },
			{ method: 'POST', path: '/api/jobs/:id/retry' },
			{ method: 'POST', path: '/api/boom' },
			{ method: 'GET', path: '*' },
		]);
	});
});
