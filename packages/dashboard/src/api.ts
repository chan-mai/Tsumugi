// 応答の型はtsumugi側が持つ, 二重に書くとREST APIの変更に画面が追随できない
// 型のみの取り込みなのでビルド時には消える
import type {
	AttemptRecord,
	CreateJobRequest,
	JobDetail,
	JobSummary,
	RunDetail,
	RunNodeView,
	RunSummary,
	StartRunRequest,
} from '../../tsumugi/src/api/types.js';

/** 一覧と詳細を同じ型で扱う, 詳細でだけ返る列は任意にする */
export type Job = JobSummary & Partial<JobDetail>;
export type Attempt = AttemptRecord;
export type Run = RunSummary & Partial<RunDetail>;
export type RunNode = RunNodeView;

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

export type ListParams = {
	state?: string;
	binding?: string;
	sort?: string;
	order?: 'asc' | 'desc';
	id?: string;
	unique_key?: string;
	concurrency_key?: string;
	created_from?: number;
	created_to?: number;
	limit: number;
	offset: number;
};

export const listJobs = (params: ListParams) => {
	const query = new URLSearchParams();
	if (params.state) query.set('state', params.state);
	if (params.binding) query.set('binding', params.binding);
	if (params.sort) query.set('sort', params.sort);
	if (params.order) query.set('order', params.order);
	if (params.id) query.set('id', params.id);
	if (params.unique_key) query.set('unique_key', params.unique_key);
	if (params.concurrency_key) query.set('concurrency_key', params.concurrency_key);
	if (params.created_from !== undefined) query.set('created_from', String(params.created_from));
	if (params.created_to !== undefined) query.set('created_to', String(params.created_to));
	query.set('limit', String(params.limit));
	query.set('offset', String(params.offset));
	return call<{ jobs: Job[]; total: number }>(`/api/jobs?${query}`);
};

export type CreateJobInput = CreateJobRequest;

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

export type ListRunParams = { state?: string; flow?: string; limit: number; offset: number };

export const listRuns = (params: ListRunParams) => {
	const query = new URLSearchParams();
	if (params.state) query.set('state', params.state);
	if (params.flow) query.set('flow', params.flow);
	query.set('limit', String(params.limit));
	query.set('offset', String(params.offset));
	return call<{ runs: Run[]; total: number }>(`/api/runs?${query}`);
};

export const getFlows = () => call<{ flows: string[] }>('/api/flows');
export const getRun = (id: string) => call<{ run: Run; nodes: RunNode[] }>(`/api/runs/${encodeURIComponent(id)}`);
export const retryRun = (id: string) => mutate(`/api/runs/${encodeURIComponent(id)}/retry`);
export const cancelRun = (id: string) => mutate(`/api/runs/${encodeURIComponent(id)}/cancel`);

export type StartRunInput = StartRunRequest;

export const startRun = async (input: StartRunInput) => {
	const res = await fetch(`${base()}/api/runs`, {
		method: 'POST',
		credentials: 'same-origin',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(input),
	});
	if (res.status === 401) throw new UnauthorizedError();
	const body = (await res.json()) as { id?: string; error?: string };
	if (!res.ok) throw new Error(body.error ?? `${res.status}`);
	return { id: body.id as string };
};

export type BindingMetrics = {
	binding: string;
	total: number;
	failed: number;
	failureRate: number;
	avgDurationMs: number;
	maxDurationMs: number;
	p95DurationMs: number;
	avgAttempts: number;
};

export type MetricsPoint = { at: number; total: number; failed: number; avgDurationMs: number };
export type Metrics = { hours: number; bindings: BindingMetrics[]; series: MetricsPoint[] };

/** 未設定の構成では501が返る, 画面はそれを受けてタブを出さない */
export class MetricsUnavailableError extends Error {
	readonly unavailable = true;
}

export const getMetrics = async (params: { hours: number; binding?: string }): Promise<Metrics> => {
	const query = new URLSearchParams({ hours: String(params.hours) });
	if (params.binding) query.set('binding', params.binding);
	const res = await fetch(`${base()}/api/metrics?${query}`, { credentials: 'same-origin' });
	if (res.status === 401) throw new UnauthorizedError();
	if (res.status === 501) throw new MetricsUnavailableError();
	const body = (await res.json().catch(() => ({}))) as Partial<Metrics> & { error?: string };
	if (!res.ok) throw new Error(body.error ?? `${res.status}`);
	return { hours: body.hours ?? params.hours, bindings: body.bindings ?? [], series: body.series ?? [] };
};

export const isMetricsUnavailable = (error: unknown): boolean =>
	typeof error === 'object' && error !== null && (error as { unavailable?: unknown }).unavailable === true;

export type BulkInput = { ids: string[] };

export type BulkOutcome = {
	ok: string[];
	failed: { id: string; reason: string }[];
	/** 上限で切った残りの見積り、0になるまで繰り返す */
	remaining: number;
};

/** 選択したジョブをまとめて処理する、状態の判定はサーバ側が行う */
export const bulkAction = async (action: 'retry' | 'cancel', input: BulkInput): Promise<BulkOutcome> => {
	const res = await fetch(`${base()}/api/jobs/bulk-${action}`, {
		method: 'POST',
		credentials: 'same-origin',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(input),
	});
	if (res.status === 401) throw new UnauthorizedError();
	const body = (await res.json().catch(() => ({}))) as Partial<BulkOutcome> & { error?: string };
	if (!res.ok) throw new Error(body.error ?? `${res.status}`);
	return { ok: body.ok ?? [], failed: body.failed ?? [], remaining: body.remaining ?? 0 };
};

export const getStats = () => call<{ byState: Record<string, number> }>('/api/stats');
export const getBindings = () => call<{ bindings: string[] }>('/api/bindings');
export const getJob = (id: string) => call<{ job: Job }>(`/api/jobs/${encodeURIComponent(id)}`);
export const retryJob = (id: string) => mutate(`/api/jobs/${encodeURIComponent(id)}/retry`);
export const cancelJob = (id: string) => mutate(`/api/jobs/${encodeURIComponent(id)}/cancel`);
