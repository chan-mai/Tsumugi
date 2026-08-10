import type { MiddlewareHandler } from 'hono';

/**
 * 認証はfail-closed(ADR-0013)
 *
 * 設定されるまでREST APIもダッシュボードも無効
 * 設定漏れが「動かない」として現れる方が静かな公開より安全
 */
export type AuthMiddleware = MiddlewareHandler;

/** 長さも含めた定数時間比較,タイミング差からの漏洩を防ぐ */
function timingSafeEqual(a: string, b: string): boolean {
	const encoder = new TextEncoder();
	const left = encoder.encode(a);
	const right = encoder.encode(b);
	let diff = left.length ^ right.length;
	const length = Math.max(left.length, right.length);
	for (let i = 0; i < length; i++) {
		diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
	}
	return diff === 0;
}

export type BearerOptions = {
	/**
	 * 同じトークンをこの名前のcookieからも受け取る
	 * HTMLは未認証でも返るので表示自体には要らない, ブラウザからAPIへAuthorizationを付けられない場合に要る
	 * cookieで受ける以上CSRFの対象になるので,発行側でSameSite=Strictを付けること
	 */
	cookie?: string;
};

function readCookie(header: string | undefined, name: string): string | undefined {
	if (!header) return undefined;
	for (const part of header.split(';')) {
		const [key, ...rest] = part.trim().split('=');
		if (key === name) return rest.join('=');
	}
	return undefined;
}

/**
 * 認証を行わずREST APIとダッシュボードを開放する(ADR-0044)
 *
 * Workerへ到達できる全員が, ジョブの内容の閲覧と投入と取り消しを行える
 * 手前で認証している構成と`wrangler dev`での確認に限って使う
 * 未設定の場合のfail-closedは変わらない, 開放するには明示的にこれを渡す必要がある
 */
export function unsafeNoAuth(): AuthMiddleware {
	let warned = false;
	return async (_c, next) => {
		// isolateごとに1回だけ, 毎リクエストのログを避ける
		if (!warned) {
			warned = true;
			console.warn('tsumugi: unsafeNoAuth is enabled, anyone who can reach this Worker can read and control jobs');
		}
		await next();
	};
}

/** `env`からトークンを引く関数, secretはモジュール初期化時に読めない */
export type TokenResolver = (env: any) => string | undefined;

/**
 * シークレット1つで始められる最短の経路
 *
 * 関数を渡すとリクエストごとに`env`から引く
 * Cloudflareのsecretは`env`経由でしか読めず,直接記述を避けるにはこの形式が必要
 * 解決できなければ通さない,設定漏れを素通りにしない(ADR-0013)
 */
export function bearerAuth(token: string | TokenResolver, options: BearerOptions = {}): AuthMiddleware {
	if (typeof token === 'string' && token.length === 0) throw new Error('bearerAuth token is empty, the fail-closed premise breaks');

	return async (c, next) => {
		const expected = typeof token === 'string' ? token : token(c.env);
		if (!expected) return c.json({ error: 'unauthorized' }, 401);

		const header = c.req.header('authorization') ?? '';
		const [scheme, value] = header.split(' ');
		const presented =
			scheme?.toLowerCase() === 'bearer' && value !== undefined
				? value
				: options.cookie
					? readCookie(c.req.header('cookie'), options.cookie)
					: undefined;

		if (presented === undefined || !timingSafeEqual(presented, expected)) {
			return c.json({ error: 'unauthorized' }, 401);
		}
		await next();
	};
}
