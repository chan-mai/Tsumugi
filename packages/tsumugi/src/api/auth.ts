import type { MiddlewareHandler } from 'hono';

/**
 * 認証はfail-closed(ADR-0013)
 *
 * 設定されるまでREST APIもダッシュボードも生えない
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
	 * ブラウザは初回のHTML取得時にAuthorizationヘッダを付けられないため,ダッシュボードを開くにはこれが要る
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

/** シークレット1つで始められる最短の経路 */
export function bearerAuth(token: string, options: BearerOptions = {}): AuthMiddleware {
	if (token.length === 0) throw new Error('bearerAuthのトークンが空, fail-closedの前提が崩れる');

	return async (c, next) => {
		const header = c.req.header('authorization') ?? '';
		const [scheme, value] = header.split(' ');
		const presented =
			scheme?.toLowerCase() === 'bearer' && value !== undefined
				? value
				: options.cookie
					? readCookie(c.req.header('cookie'), options.cookie)
					: undefined;

		if (presented === undefined || !timingSafeEqual(presented, token)) {
			return c.json({ error: 'unauthorized' }, 401);
		}
		await next();
	};
}
