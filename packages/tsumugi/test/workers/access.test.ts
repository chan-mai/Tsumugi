import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearJwksCache, cloudflareAccess, verifyAccessJwt, type Jwks } from '../../src/api/access.js';
import { Performer } from '../../src/core/api.js';
import type { RestEnv } from '../../src/api/rest.js';
import { defineTsumugi } from '../../src/worker.js';

const TEAM = 'acme';
const AUD = 'aud-tag-123';
const ISSUER = `https://${TEAM}.cloudflareaccess.com`;
const KID = 'test-key-1';

let signingKey: CryptoKey;
let jwks: Jwks;
/** 署名だけ違う鍵,正しい鍵で検証できないことを確かめる */
let attackerKey: CryptoKey;

const bytesToBase64Url = (bytes: Uint8Array) => {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const encodeSegment = (value: unknown) => bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));

async function makeJwt(claims: Record<string, unknown>, options: { key?: CryptoKey; kid?: string; alg?: string } = {}): Promise<string> {
	const header = encodeSegment({ alg: options.alg ?? 'RS256', kid: options.kid ?? KID, typ: 'JWT' });
	const payload = encodeSegment(claims);
	const signed = new TextEncoder().encode(`${header}.${payload}`);
	const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', options.key ?? signingKey, signed);
	return `${header}.${payload}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

const validClaims = (over: Record<string, unknown> = {}) => ({
	aud: AUD,
	iss: ISSUER,
	exp: Math.floor(Date.now() / 1000) + 600,
	email: 'someone@example.com',
	...over,
});

let jwksFetches = 0;
const options = () => ({
	teamDomain: TEAM,
	aud: AUD,
	fetchJwks: async () => {
		jwksFetches++;
		return jwks;
	},
});

beforeAll(async () => {
	const algorithm = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
	const pair = (await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])) as CryptoKeyPair;
	signingKey = pair.privateKey;
	const publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
	jwks = { keys: [{ ...publicJwk, kid: KID }] };

	const attackerPair = (await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])) as CryptoKeyPair;
	attackerKey = attackerPair.privateKey;
});

beforeEach(() => {
	clearJwksCache();
	jwksFetches = 0;
});

describe('Access JWTの検証', () => {
	it('正しい署名とクレームなら通る', async () => {
		const token = await makeJwt(validClaims());
		const claims = await verifyAccessJwt(token, options(), Date.now());
		expect(claims).toMatchObject({ aud: AUD, iss: ISSUER, email: 'someone@example.com' });
	});

	it('別の鍵で署名されていれば拒否する', async () => {
		const token = await makeJwt(validClaims(), { key: attackerKey });
		expect(await verifyAccessJwt(token, options(), Date.now())).toBeNull();
	});

	it('署名が改竄されていれば拒否する', async () => {
		const token = await makeJwt(validClaims());
		const tampered = `${token.slice(0, -4)}AAAA`;
		expect(await verifyAccessJwt(tampered, options(), Date.now())).toBeNull();
	});

	it('ペイロードを差し替えると署名が合わず拒否する', async () => {
		const token = await makeJwt(validClaims());
		const [header, , signature] = token.split('.') as [string, string, string];
		const forged = encodeSegment(validClaims({ email: 'attacker@example.com' }));
		expect(await verifyAccessJwt(`${header}.${forged}.${signature}`, options(), Date.now())).toBeNull();
	});

	it('audが違えば拒否する', async () => {
		const token = await makeJwt(validClaims({ aud: 'other-app' }));
		expect(await verifyAccessJwt(token, options(), Date.now())).toBeNull();
	});

	it('issが違えば拒否する', async () => {
		const token = await makeJwt(validClaims({ iss: 'https://evil.cloudflareaccess.com' }));
		expect(await verifyAccessJwt(token, options(), Date.now())).toBeNull();
	});

	it('期限切れなら拒否する', async () => {
		const token = await makeJwt(validClaims({ exp: Math.floor(Date.now() / 1000) - 1 }));
		expect(await verifyAccessJwt(token, options(), Date.now())).toBeNull();
	});

	it('nbfが未来なら拒否する', async () => {
		const token = await makeJwt(validClaims({ nbf: Math.floor(Date.now() / 1000) + 600 }));
		expect(await verifyAccessJwt(token, options(), Date.now())).toBeNull();
	});

	it('expが無ければ拒否する', async () => {
		const { exp: _exp, ...rest } = validClaims();
		const token = await makeJwt(rest);
		expect(await verifyAccessJwt(token, options(), Date.now())).toBeNull();
	});

	it('algをnoneに差し替えても通さない', async () => {
		// ヘッダのalgを信じると署名検証を迂回される
		const header = encodeSegment({ alg: 'none', kid: KID, typ: 'JWT' });
		const payload = encodeSegment(validClaims());
		expect(await verifyAccessJwt(`${header}.${payload}.`, options(), Date.now())).toBeNull();
	});

	it('知らないkidなら拒否する', async () => {
		const token = await makeJwt(validClaims(), { kid: 'unknown-key' });
		expect(await verifyAccessJwt(token, options(), Date.now())).toBeNull();
	});

	it('形式が壊れていれば拒否する', async () => {
		for (const bad of ['', 'a.b', 'a.b.c.d', 'not-a-jwt']) {
			expect(await verifyAccessJwt(bad, options(), Date.now())).toBeNull();
		}
	});

	it('audが配列でも一致すれば通る', async () => {
		const token = await makeJwt(validClaims({ aud: ['other', AUD] }));
		expect(await verifyAccessJwt(token, options(), Date.now())).not.toBeNull();
	});

	it('JWKSはキャッシュされ毎回取得しない', async () => {
		const token = await makeJwt(validClaims());
		const shared = options();
		await verifyAccessJwt(token, shared, Date.now());
		await verifyAccessJwt(token, shared, Date.now());
		expect(jwksFetches).toBe(1);
	});
});

describe('cloudflareAccessミドルウェア', () => {
	class Noop extends Performer<unknown, void, {}, RestEnv> {
		async perform(): Promise<void> {}
	}

	const handler = () => defineTsumugi({ performers: { ACC: Noop }, auth: cloudflareAccess(options()) });

	const call = (headers: Record<string, string>) =>
		handler().fetch!(
			new Request('https://example.com/api/jobs', { headers }),
			env as RestEnv,
			{
				waitUntil: () => {},
				passThroughOnException: () => {},
			} as unknown as ExecutionContext,
		);

	it('ヘッダが無ければ401', async () => {
		expect((await call({})).status).toBe(401);
	});

	it('正しいJWTがヘッダにあれば通る', async () => {
		const token = await makeJwt(validClaims());
		expect((await call({ 'cf-access-jwt-assertion': token })).status).toBe(200);
	});

	it('CF_Authorizationクッキーからも読む', async () => {
		const token = await makeJwt(validClaims());
		expect((await call({ cookie: `foo=bar; CF_Authorization=${token}` })).status).toBe(200);
	});

	it('署名が不正なら401', async () => {
		const token = await makeJwt(validClaims(), { key: attackerKey });
		expect((await call({ 'cf-access-jwt-assertion': token })).status).toBe(401);
	});

	it('設定が空なら構築時点で拒否する', () => {
		expect(() => cloudflareAccess({ teamDomain: '', aud: AUD })).toThrow();
		expect(() => cloudflareAccess({ teamDomain: TEAM, aud: '' })).toThrow();
	});
});
