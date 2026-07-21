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
	/** サーバが保持期間から出す近似, 最終的な可否はretryの応答が決める */
	retryable?: boolean;
	/** 詳細でのみ返る試行履歴, 新しい順 */
	attempts_log?: Attempt[];
};

export type Attempt = {
	attempt: number;
	state: string;
	started_at: number | null;
	finished_at: number;
	error: string | null;
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
	if (!res.ok) {
		// サーバが理由を返す場合はそのまま見せる, 数字だけでは何をすればよいか分からない
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `${res.status}`);
	}
	return res.json() as Promise<T>;
}

export type MutationOutcome = { ok: boolean; gone: boolean; message: string };

/**
 * retry / cancelの結果
 * 410は保持期間を過ぎてDOから消えた状態, 一覧には残るので押しても二度と通らない
 */
async function mutate(path: string): Promise<MutationOutcome> {
	const res = await fetch(`${base()}${path}`, { method: 'POST', credentials: 'same-origin' });
	if (res.status === 401) throw new UnauthorizedError();
	if (res.ok) return { ok: true, gone: false, message: 'Accepted' };

	const body = (await res.json().catch(() => ({}))) as { error?: string };
	return {
		ok: false,
		gone: res.status === 410,
		message: body.error ?? `Request failed (${res.status})`,
	};
}

export type ListParams = { state?: string; binding?: string; sort?: string; order?: 'asc' | 'desc'; limit: number; offset: number };

export const listJobs = (params: ListParams) => {
	const query = new URLSearchParams();
	if (params.state) query.set('state', params.state);
	if (params.binding) query.set('binding', params.binding);
	if (params.sort) query.set('sort', params.sort);
	if (params.order) query.set('order', params.order);
	query.set('limit', String(params.limit));
	query.set('offset', String(params.offset));
	return call<{ jobs: Job[]; total: number }>(`/api/jobs?${query}`);
};

export type CreateJobInput = {
	binding: string;
	payload: unknown;
	maxAttempts?: number;
	delayMs?: number;
	priority?: number;
	uniqueKey?: string;
	concurrencyKey?: string;
};

export const createJob = async (input: CreateJobInput) => {
	const res = await fetch(`${base()}/api/jobs`, {
		method: 'POST',
		credentials: 'same-origin',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(input),
	});
	if (res.status === 401) throw new UnauthorizedError();
	const body = (await res.json()) as { id?: string; error?: string };
	// 検証に落ちた理由はサーバが返すので,そのまま見せる
	if (!res.ok) throw new Error(body.error ?? `${res.status}`);
	return { id: body.id as string };
};

export const getStats = () => call<{ byState: Record<string, number> }>('/api/stats');
export const getBindings = () => call<{ bindings: string[] }>('/api/bindings');
export const getJob = (id: string) => call<{ job: Job }>(`/api/jobs/${encodeURIComponent(id)}`);
export const retryJob = (id: string) => mutate(`/api/jobs/${encodeURIComponent(id)}/retry`);
export const cancelJob = (id: string) => mutate(`/api/jobs/${encodeURIComponent(id)}/cancel`);
