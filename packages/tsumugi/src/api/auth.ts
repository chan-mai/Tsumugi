import type { MiddlewareHandler } from 'hono';

/**
 * 認証はfail-closed(ADR-0013)
 *
 * 設定されるまでREST APIもダッシュボードも生えない
 * 設定漏れが「動かない」として現れる方が静かな公開より安全
 */
export type AuthMiddleware = MiddlewareHandler;

/** 長さも含めた定数時間比較, タイミング差からの漏洩を防ぐ */
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

/** シークレット1つで始められる最短の経路 */
export function bearerAuth(token: string): AuthMiddleware {
	if (token.length === 0) throw new Error('bearerAuthのトークンが空, fail-closedの前提が崩れる');

	return async (c, next) => {
		const header = c.req.header('authorization') ?? '';
		const [scheme, value] = header.split(' ');
		if (scheme?.toLowerCase() !== 'bearer' || value === undefined || !timingSafeEqual(value, token)) {
			return c.json({ error: 'unauthorized' }, 401);
		}
		await next();
	};
}
