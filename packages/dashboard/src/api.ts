// 応答型はtsumugi側で定義, 二重定義はREST API変更への追随漏れ要因
import type {
	AttemptRecord,
	CreateJobRequest,
	JobDetail,
	JobSummary,
	RunDetail,
	RunNodeView,
	RunSummary,
	ScheduleSummary,
	StartRunRequest,
	DiagnosticsResponse,
	MetricsResponse,
	PolicyView,
	TriggerScheduleResponse,
	UpdatePolicyRequest,
} from '../../tsumugi/src/api/types.js';

export type Job = JobSummary & Partial<JobDetail>;
export type Attempt = AttemptRecord;
export type Run = RunSummary & Partial<RunDetail>;
export type RunNode = RunNodeView;
export type Schedule = ScheduleSummary;

declare global {
	interface Window {
		__TSUMUGI__?: { tokenCookie: string | null };
	}
}

/** Cloudflare Access等ではnull */
export const tokenCookie = () => window.__TSUMUGI__?.tokenCookie ?? null;

/** 401判別用, ミニファイ, バンドル境界でのinstanceof不一致対策に値で保持 */
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

/** httpsのみSecure付与, http動作のwrangler devでの保存失敗対策 */
export const cookieAttributes = (protocol: string): string => `path=/; SameSite=Strict${protocol === 'https:' ? '; Secure' : ''}`;

export function saveToken(value: string): void {
	const name = tokenCookie();
	if (!name) return;
	document.cookie = `${name}=${encodeURIComponent(value)}; ${cookieAttributes(location.protocol)}`;
}

async function call<T>(path: string, init: RequestInit = {}, Unavailable?: new () => Error): Promise<T> {
	const res = await fetch(path, { ...init, credentials: 'same-origin' });
	if (res.status === 401) throw new UnauthorizedError();
	if (res.status === 501 && Unavailable) throw new Unavailable();
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `${res.status}`);
	}
	return res.json() as Promise<T>;
}

export type MutationOutcome = { ok: boolean; gone: boolean; message: string };

// 410は保持期間経過でDOから削除済み, 一覧に残存しても操作不可
async function mutate(path: string): Promise<MutationOutcome> {
	const res = await fetch(path, { method: 'POST', credentials: 'same-origin' });
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

export const createJob = (input: CreateJobInput) =>
	call<{ id: string }>('/api/jobs', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(input),
	});

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

export const startRun = (input: StartRunInput) =>
	call<{ id: string }>('/api/runs', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(input),
	});

export type Metrics = MetricsResponse;

export class MetricsUnavailableError extends Error {
	readonly unavailable = true;
}

export const getMetrics = async (params: { hours: number; binding?: string }): Promise<Metrics> => {
	const query = new URLSearchParams({ hours: String(params.hours) });
	if (params.binding) query.set('binding', params.binding);
	const body = await call<Partial<Metrics>>(`/api/metrics?${query}`, {}, MetricsUnavailableError);
	return { hours: body.hours ?? params.hours, bindings: body.bindings ?? [], series: body.series ?? [] };
};

export const isMetricsUnavailable = (error: unknown): boolean =>
	typeof error === 'object' && error !== null && (error as { unavailable?: unknown }).unavailable === true;

export class SchedulesUnavailableError extends Error {
	readonly unavailable = true;
}

export const listSchedules = async (): Promise<Schedule[]> => {
	const body = await call<{ schedules?: Schedule[] }>('/api/schedules', {}, SchedulesUnavailableError);
	return body.schedules ?? [];
};

/** 停止中に経過した回は再開時に破棄 */
export const setSchedulePaused = (name: string, paused: boolean) =>
	call<{ ok: true }>(`/api/schedules/${encodeURIComponent(name)}/${paused ? 'pause' : 'resume'}`, { method: 'POST' });

/** 一時停止中も可, 次回予定は不変 */
export const triggerSchedule = (name: string) =>
	call<TriggerScheduleResponse>(`/api/schedules/${encodeURIComponent(name)}/trigger`, { method: 'POST' });

export type BulkInput = { ids: string[] };

export type BulkOutcome = {
	ok: string[];
	failed: { id: string; reason: string }[];
};

/** 状態判定はサーバ側 */
export const bulkAction = async (action: 'retry' | 'cancel', input: BulkInput): Promise<BulkOutcome> => {
	const body = await call<Partial<BulkOutcome>>(`/api/jobs/bulk-${action}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(input),
	});
	return { ok: body.ok ?? [], failed: body.failed ?? [] };
};

export type Policy = PolicyView;
export type BindingDiagnostics = DiagnosticsResponse['bindings'][string];

export const getDiagnostics = () => call<DiagnosticsResponse>('/api/diagnostics');

/** 省略項目は不変(#27) */
export const updatePolicy = (binding: string, patch: UpdatePolicyRequest) =>
	call<{ binding: string; shards: number; policy: Policy }>(`/api/bindings/${encodeURIComponent(binding)}/policy`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(patch),
	});

/** 静的設定へ復帰(#27) */
export const resetPolicy = (binding: string) =>
	call<{ ok: true }>(`/api/bindings/${encodeURIComponent(binding)}/policy/reset`, { method: 'POST' });

export const getBindings = () => call<{ bindings: string[] }>('/api/bindings');
export const getJob = (id: string) => call<{ job: Job }>(`/api/jobs/${encodeURIComponent(id)}`);
export const retryJob = (id: string) => mutate(`/api/jobs/${encodeURIComponent(id)}/retry`);
export const cancelJob = (id: string) => mutate(`/api/jobs/${encodeURIComponent(id)}/cancel`);
