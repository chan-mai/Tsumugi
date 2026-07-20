import type { AuthMiddleware } from './auth.js';

/**
 * Cloudflare AccessのJWT検証
 *
 * Accessはリクエストに`Cf-Access-Jwt-Assertion`ヘッダを付けて転送する
 * 署名を検証せずヘッダの存在だけを見ると, Accessを迂回した直接アクセスを通してしまう
 */
export type AccessOptions = {
	/** `<team>.cloudflareaccess.com`のteam部分 */
	teamDomain: string;
	/** Accessアプリケーションのaudience tag */
	aud: string;
	/** JWKSの再取得間隔 */
	cacheTtlMs?: number;
	/** テスト用の差し替え口,既定は公開鍵エンドポイントへのfetch */
	fetchJwks?: (certsUrl: string) => Promise<Jwks>;
};

export type AccessJwk = JsonWebKey & { kid?: string };
export type Jwks = { keys: AccessJwk[] };

type Claims = {
	aud?: string | string[];
	iss?: string;
	exp?: number;
	nbf?: number;
	email?: string;
	sub?: string;
};

const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;

function base64UrlToBytes(value: string): Uint8Array {
	const padded = value.replace(/-/g, '+').replace(/_/g, '/');
	const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function decodeJson<T>(segment: string): T | null {
	try {
		return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment))) as T;
	} catch {
		return null;
	}
}

/** 検証済みのクレーム,失敗時はnull */
export async function verifyAccessJwt(token: string, options: AccessOptions, now: number): Promise<Claims | null> {
	const parts = token.split('.');
	if (parts.length !== 3) return null;
	const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];

	const header = decodeJson<{ alg?: string; kid?: string }>(headerSegment);
	// algをJWTの言うままに信じるとalg=noneやHS256への差し替えを許す
	if (!header || header.alg !== 'RS256' || !header.kid) return null;

	const claims = decodeJson<Claims>(payloadSegment);
	if (!claims) return null;

	const issuer = `https://${options.teamDomain}.cloudflareaccess.com`;
	if (claims.iss !== issuer) return null;

	const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud === undefined ? [] : [claims.aud];
	if (!audiences.includes(options.aud)) return null;

	const seconds = Math.floor(now / 1000);
	if (typeof claims.exp !== 'number' || claims.exp <= seconds) return null;
	if (typeof claims.nbf === 'number' && claims.nbf > seconds) return null;

	const jwks = await loadJwks(options);
	const jwk = jwks.keys.find((key) => key.kid === header.kid);
	if (!jwk) return null;

	const key = await crypto.subtle.importKey(
		'jwk',
		{ ...jwk, alg: 'RS256', ext: true },
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
		false,
		['verify'],
	);
	const signed = new TextEncoder().encode(`${headerSegment}.${payloadSegment}`);
	const signature = base64UrlToBytes(signatureSegment);
	const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signed);
	return ok ? claims : null;
}

const jwksCache = new Map<string, { jwks: Jwks; expiresAt: number }>();

async function loadJwks(options: AccessOptions): Promise<Jwks> {
	const certsUrl = `https://${options.teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`;
	const ttl = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
	const cached = jwksCache.get(certsUrl);
	if (cached && cached.expiresAt > Date.now()) return cached.jwks;

	const fetcher = options.fetchJwks ?? (async (url: string) => (await fetch(url)).json<Jwks>());
	const jwks = await fetcher(certsUrl);
	jwksCache.set(certsUrl, { jwks, expiresAt: Date.now() + ttl });
	return jwks;
}

/** テストや鍵ローテーション時にキャッシュを捨てる */
export function clearJwksCache(): void {
	jwksCache.clear();
}

export function cloudflareAccess(options: AccessOptions): AuthMiddleware {
	if (options.teamDomain.length === 0 || options.aud.length === 0) {
		throw new Error('cloudflareAccessにはteamDomainとaudが必須, fail-closedの前提が崩れる');
	}

	return async (c, next) => {
		const token = c.req.header('cf-access-jwt-assertion') ?? readCookie(c.req.header('cookie'), 'CF_Authorization');
		if (!token) return c.json({ error: 'unauthorized' }, 401);

		const claims = await verifyAccessJwt(token, options, Date.now());
		if (!claims) return c.json({ error: 'unauthorized' }, 401);

		c.set('accessClaims', claims);
		await next();
	};
}

function readCookie(header: string | undefined, name: string): string | undefined {
	if (!header) return undefined;
	for (const part of header.split(';')) {
		const [key, ...rest] = part.trim().split('=');
		if (key === name) return rest.join('=');
	}
	return undefined;
}
