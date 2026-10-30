export type Context<Env> = {
	readonly env: Env;
	readonly req: {
		readonly raw: Request;
		readonly url: string;
		param(name: string): string;
		header(name: string): string | undefined;
		json(): Promise<unknown>;
	};
	json(body: unknown, status?: number): Response;
	html(body: string): Response;
};

// undefinedは後続委譲
export type Handler<Env> = (c: Context<Env>) => Response | undefined | Promise<Response | undefined>;

export type Route = { readonly method: string; readonly path: string };

type Entry<Env> = { method: string | null; segments: string[]; handler: Handler<Env> };

const text = (body: string, status: number) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=UTF-8' } });

function decode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

// 末尾`*`は0個以上のセグメント, `:name`は空でない1セグメント
function match(pattern: string[], path: string[]): Record<string, string> | null {
	const params: Record<string, string> = {};
	for (let i = 0; i < pattern.length; i++) {
		const segment = pattern[i]!;
		if (segment === '*' && i === pattern.length - 1) return params;
		const actual = path[i];
		if (actual === undefined) return null;
		if (segment.startsWith(':')) {
			if (actual === '') return null;
			params[segment.slice(1)] = decode(actual);
		} else if (segment !== actual) {
			return null;
		}
	}
	return pattern.length === path.length ? params : null;
}

const split = (path: string) => (path === '*' ? ['*'] : path.split('/'));

export function createRouter<Env>() {
	const entries: Entry<Env>[] = [];
	const routes: Route[] = [];

	const add = (method: string | null, path: string, handler: Handler<Env>) => {
		entries.push({ method, segments: split(path), handler });
		if (method !== null) routes.push({ method, path });
	};

	async function dispatch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname.split('/');
		// HEADはGETの経路で処理, 本文のみ破棄
		const method = request.method === 'HEAD' ? 'GET' : request.method;

		for (const entry of entries) {
			if (entry.method !== null && entry.method !== method) continue;
			const params = match(entry.segments, path);
			if (!params) continue;

			const response = await entry.handler({
				env,
				req: {
					raw: request,
					url: request.url,
					param: (name) => params[name] ?? '',
					header: (name) => request.headers.get(name) ?? undefined,
					json: () => request.json(),
				},
				json: (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
				html: (body) => new Response(body, { headers: { 'content-type': 'text/html; charset=UTF-8' } }),
			});
			if (response) return response;
		}
		return text('404 Not Found', 404);
	}

	return {
		routes: routes as readonly Route[],
		use: (path: string, handler: Handler<Env>) => add(null, path, handler),
		get: (path: string, handler: Handler<Env>) => add('GET', path, handler),
		post: (path: string, handler: Handler<Env>) => add('POST', path, handler),
		async fetch(request: Request, env: Env): Promise<Response> {
			let response: Response;
			try {
				response = await dispatch(request, env);
			} catch (err) {
				console.error(err);
				response = text('Internal Server Error', 500);
			}
			if (request.method !== 'HEAD') return response;
			return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
		},
	};
}
