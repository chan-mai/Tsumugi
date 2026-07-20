export type Job = {
	id: string;
	binding: string;
	state: string;
	priority: number;
	attempts: number;
	max_attempts: number;
	created_at: number;
	updated_at: number;
	dispatched_at: number | null;
	payload?: string;
	unique_key?: string | null;
	concurrency_key?: string | null;
	guarantee?: string;
};

declare global {
	interface Window {
		__TSUMUGI__?: { base: string; tokenCookie: string | null };
	}
}

const base = () => window.__TSUMUGI__?.base ?? '';

/** 設定されていればトークン入力を出せる, Cloudflare Access等では不要なのでnull */
export const tokenCookie = () => window.__TSUMUGI__?.tokenCookie ?? null;

/**
 * 401の判別
 * instanceofはミニファイやバンドル境界で壊れやすいので値で持つ
 */
export class UnauthorizedError extends Error {
	readonly unauthorized = true;

	constructor() {
		super('unauthorized');
		this.name = 'UnauthorizedError';
	}
}

export function isUnauthorized(error: unknown): boolean {
	return typeof error === 'object' && error !== null && (error as { unauthorized?: unknown }).unauthorized === true;
}

export function saveToken(value: string): void {
	const name = tokenCookie();
	if (!name) return;
	document.cookie = `${name}=${encodeURIComponent(value)}; path=/; SameSite=Strict`;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
	const res = await fetch(`${base()}${path}`, { ...init, credentials: 'same-origin' });
	if (res.status === 401) throw new UnauthorizedError();
	if (!res.ok) throw new Error(`${res.status}`);
	return res.json() as Promise<T>;
}

export type ListParams = { state?: string; binding?: string; limit: number; offset: number };

export const listJobs = (params: ListParams) => {
	const query = new URLSearchParams();
	if (params.state) query.set('state', params.state);
	if (params.binding) query.set('binding', params.binding);
	query.set('limit', String(params.limit));
	query.set('offset', String(params.offset));
	return call<{ jobs: Job[]; total: number }>(`/api/jobs?${query}`);
};

export const getStats = () => call<{ byState: Record<string, number> }>('/api/stats');
export const getBindings = () => call<{ bindings: string[] }>('/api/bindings');
export const getJob = (id: string) => call<{ job: Job }>(`/api/jobs/${encodeURIComponent(id)}`);
export const retryJob = (id: string) => call<{ ok: boolean }>(`/api/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST' });
export const cancelJob = (id: string) => call<{ ok: boolean }>(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
