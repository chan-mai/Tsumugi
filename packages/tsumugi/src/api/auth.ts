import type { MiddlewareHandler } from 'hono';

/**
 * 認証はfail-closed(ADR-0013)
 * 未設定時はREST API, ダッシュボードとも無効
 * 設定漏れ時は無警告の公開より動作停止が安全
 */
export type AuthMiddleware = MiddlewareHandler;

// 長さ含め定数時間比較, タイミング差による漏洩防止
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
	 * 同一トークンも受け取るcookie名
	 * HTML表示には不要, ブラウザからAPIへAuthorization付与不可の場合に必要
	 * CSRF対象, 発行側でSameSite=Strict必須
	 */
	cookie?: string;
};

export function readCookie(header: string | undefined, name: string): string | undefined {
	if (!header) return undefined;
	for (const part of header.split(';')) {
		const [key, ...rest] = part.trim().split('=');
		if (key !== name) continue;
		const value = rest.join('=');
		// 書き出し側のencodeURIComponentを復号, 未復号ではbase64の`+ / =`が不一致
		try {
			return decodeURIComponent(value);
		} catch {
			// 不正な%列は素の値で比較, 例外では401でなく500
			return value;
		}
	}
	return undefined;
}

/**
 * 認証なしでREST API, ダッシュボードを公開(ADR-0044)
 * Workerへ到達可能な全員がジョブの閲覧, 投入, 取り消しを実行可能
 * 前段で認証済みの構成, `wrangler dev`での確認に限り使用
 * 未設定時のfail-closedは不変, 公開にはこれの明示指定が必要
 */
export function unsafeNoAuth(): AuthMiddleware {
	let warned = false;
	return async (_c, next) => {
		// isolate毎に1回, 毎リクエストのログ回避
		if (!warned) {
			warned = true;
			console.warn('tsumugi: unsafeNoAuth is enabled, anyone who can reach this Worker can read and control jobs');
		}
		await next();
	};
}

/** secretはモジュール初期化時に読込不可 */
export type TokenResolver = (env: any) => string | undefined;

/**
 * 関数指定時はリクエスト毎に`env`から取得
 * Cloudflareのsecretは`env`経由のみ読込可, 直接記述回避にはこの形式が必要
 * 解決不能時は401, 設定漏れ時の無認証アクセス防止(ADR-0013)
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
