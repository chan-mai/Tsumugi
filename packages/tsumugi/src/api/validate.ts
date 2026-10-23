import { CANCELLABLE_STATES, RETRYABLE_STATES } from '../core/transitions.js';
import { normalizeTraceparent } from '../core/trace.js';
import type { CreateJobRequest, StartRunRequest, UpdatePolicyRequest } from './types.js';

export type CreateJobInput = CreateJobRequest;

export function validateCreateJob(
	body: unknown,
	bindings: readonly string[] | undefined,
	traceparentHeader?: string,
): { input: CreateJobInput } | { error: string } {
	if (typeof body !== 'object' || body === null) return { error: 'body must be an object' };
	const raw = body as Record<string, unknown>;

	if (typeof raw.binding !== 'string' || raw.binding.length === 0) return { error: 'binding is required' };
	// 未登録bindingは実行時に必ず失敗, 投入時に拒否
	// 空配列は登録0件, 省略時のみ検証なし
	if (bindings !== undefined && !bindings.includes(raw.binding)) return { error: `unknown binding: ${raw.binding}` };
	if (!('payload' in raw)) return { error: 'payload is required' };

	const numbers: [keyof CreateJobInput, unknown][] = [
		['maxAttempts', raw.maxAttempts],
		['delayMs', raw.delayMs],
		['expiresInMs', raw.expiresInMs],
		['priority', raw.priority],
	];
	for (const [name, value] of numbers) {
		if (value !== undefined && !Number.isInteger(value)) return { error: `${name} must be an integer` };
	}
	if (typeof raw.maxAttempts === 'number' && raw.maxAttempts < 1) return { error: 'maxAttempts must be at least 1' };
	if (typeof raw.delayMs === 'number' && raw.delayMs < 0) return { error: 'delayMs must not be negative' };
	if (typeof raw.expiresInMs === 'number' && raw.expiresInMs < 1) {
		return { error: 'expiresInMs must be a positive integer' };
	}

	for (const name of ['concurrencyKey', 'uniqueKey', 'partitionKey'] as const) {
		if (raw[name] !== undefined && typeof raw[name] !== 'string') return { error: `${name} must be a string` };
	}

	const input: CreateJobInput = { binding: raw.binding, payload: raw.payload };
	const traceparent = raw.traceparent !== undefined ? raw.traceparent : traceparentHeader;
	if (traceparent !== undefined) {
		if (typeof traceparent !== 'string') return { error: 'traceparent must be a string' };
		try {
			const normalized = normalizeTraceparent(traceparent);
			if (normalized !== null) input.traceparent = normalized;
		} catch (error) {
			return { error: error instanceof Error ? error.message : 'invalid traceparent' };
		}
	}
	if (typeof raw.maxAttempts === 'number') input.maxAttempts = raw.maxAttempts;
	if (typeof raw.delayMs === 'number') input.delayMs = raw.delayMs;
	if (typeof raw.expiresInMs === 'number') input.expiresInMs = raw.expiresInMs;
	if (typeof raw.priority === 'number') input.priority = raw.priority;
	if (typeof raw.concurrencyKey === 'string' && raw.concurrencyKey) input.concurrencyKey = raw.concurrencyKey;
	if (typeof raw.uniqueKey === 'string' && raw.uniqueKey) input.uniqueKey = raw.uniqueKey;
	if (typeof raw.partitionKey === 'string' && raw.partitionKey) input.partitionKey = raw.partitionKey;
	return { input };
}

type RescheduleInput = { runAfter: number; priority?: number };

export function validateReschedule(body: unknown, now: number): { input: RescheduleInput } | { error: string } {
	if (typeof body !== 'object' || body === null) return { error: 'body must be an object' };
	const raw = body as Record<string, unknown>;

	const numbers: [string, unknown][] = [
		['runAt', raw.runAt],
		['delayMs', raw.delayMs],
		['priority', raw.priority],
	];
	for (const [name, value] of numbers) {
		if (value !== undefined && !Number.isInteger(value)) return { error: `${name} must be an integer` };
	}

	const hasRunAt = typeof raw.runAt === 'number';
	const hasDelay = typeof raw.delayMs === 'number';
	if (hasRunAt && hasDelay) return { error: 'runAt and delayMs are mutually exclusive' };
	if (!hasRunAt && !hasDelay) return { error: 'runAt or delayMs is required' };
	if (hasDelay && (raw.delayMs as number) < 0) return { error: 'delayMs must not be negative' };

	const runAfter = hasRunAt ? (raw.runAt as number) : now + (raw.delayMs as number);
	return { input: { runAfter, ...(typeof raw.priority === 'number' ? { priority: raw.priority } : {}) } };
}

export type StartRunInput = StartRunRequest;

export function validateStartRun(body: unknown, flows: readonly string[] | undefined): { input: StartRunInput } | { error: string } {
	if (typeof body !== 'object' || body === null) return { error: 'body must be an object' };
	const raw = body as Record<string, unknown>;

	if (typeof raw.flow !== 'string' || raw.flow.length === 0) return { error: 'flow is required' };
	// 未登録flowは開始後に必ず失敗, 開始時に拒否
	if (flows !== undefined && !flows.includes(raw.flow)) return { error: `unknown flow: ${raw.flow}` };
	if (!('input' in raw)) return { error: 'input is required' };
	if (raw.id !== undefined && typeof raw.id !== 'string') return { error: 'id must be a string' };
	if (raw.deadlineMs !== undefined && (typeof raw.deadlineMs !== 'number' || !Number.isInteger(raw.deadlineMs) || raw.deadlineMs <= 0)) {
		return { error: 'deadlineMs must be a positive integer' };
	}

	const input: StartRunInput = { flow: raw.flow, input: raw.input };
	if (typeof raw.id === 'string' && raw.id) input.id = raw.id;
	if (typeof raw.deadlineMs === 'number') input.deadlineMs = raw.deadlineMs;
	return { input };
}

type UpdatePolicyInput = UpdatePolicyRequest;

// 省略と明示的nullを区別
export function validatePolicy(body: unknown): { input: UpdatePolicyInput } | { error: string } {
	if (typeof body !== 'object' || body === null) return { error: 'body must be an object' };
	const raw = body as Record<string, unknown>;

	const input: UpdatePolicyInput = {};

	if ('paused' in raw) {
		if (typeof raw.paused !== 'boolean') return { error: 'paused must be a boolean' };
		input.paused = raw.paused;
	}

	// 0は投入停止指定として有効, 負数, 小数のみ拒否
	for (const name of ['concurrency', 'perKeyConcurrency', 'reaperGraceMs'] as const) {
		if (!(name in raw)) continue;
		const value = raw[name];
		if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return { error: `${name} must be a non-negative integer` };
		input[name] = value;
	}

	// エージングはnullで無効, 有効時は正の整数(ADR-0020)
	if ('agingIntervalMs' in raw) {
		const value = raw.agingIntervalMs;
		if (value !== null && (typeof value !== 'number' || !Number.isInteger(value) || value <= 0)) {
			return { error: 'agingIntervalMs must be a positive integer or null' };
		}
		input.agingIntervalMs = value as number | null;
	}

	for (const name of ['rate', 'perKeyRate'] as const) {
		if (!(name in raw)) continue;
		const value = raw[name];
		if (value === null) input[name] = null;
		else {
			if (typeof value !== 'object') return { error: `${name} must be an object or null` };
			const { tokens, intervalMs } = value as Record<string, unknown>;
			if (typeof tokens !== 'number' || !Number.isInteger(tokens) || tokens < 0) {
				return { error: `${name}.tokens must be a non-negative integer` };
			}
			if (typeof intervalMs !== 'number' || !Number.isInteger(intervalMs) || intervalMs <= 0) {
				return { error: `${name}.intervalMs must be a positive integer` };
			}
			input[name] = { tokens, intervalMs };
		}
	}

	if (Object.keys(input).length === 0) return { error: 'no policy field to update' };
	return { input };
}

// DOのtick1回の上限と同一, 超過分は呼び出し側で繰り返し処理
export const BULK_LIMIT_MAX = 200;

const BULK_STATES = { retry: RETRYABLE_STATES, cancel: CANCELLABLE_STATES } as const;

// 画面はID列挙, 一覧外の件数を扱う利用者は条件指定
export type BulkTarget =
	| { kind: 'ids'; ids: string[] }
	| {
			kind: 'filter';
			binding?: string;
			/** 未指定時は操作の受理状態すべて */
			states: readonly string[];
			uniqueKey?: string;
			concurrencyKey?: string;
			createdFrom?: number;
			createdTo?: number;
			limit: number;
	  };

/**
 * `ids`指定時はidsのみ対象, 条件併用は対象の解釈が二通り
 * 条件指定時の状態は操作の受理状態に限定, 非限定では対象が減らず繰り返しが終了不能
 */
const BULK_KEYS = ['ids', 'binding', 'state', 'unique_key', 'concurrency_key', 'created_from', 'created_to', 'limit'];

export function validateBulk(body: unknown, action: 'retry' | 'cancel'): { input: BulkTarget } | { error: string } {
	if (typeof body !== 'object' || body === null) return { error: 'body must be an object' };
	const raw = body as Record<string, unknown>;
	const allowed: readonly string[] = BULK_STATES[action];

	// 綴り違いの無視で全件対象化
	const unknown = Object.keys(raw).find((key) => !BULK_KEYS.includes(key));
	if (unknown !== undefined) return { error: `unknown field: ${unknown}` };

	if (raw.ids !== undefined) {
		if (!Array.isArray(raw.ids)) return { error: 'ids must be an array' };
		if (raw.ids.length === 0) return { error: 'ids must not be empty' };
		if (raw.ids.length > BULK_LIMIT_MAX) return { error: `ids must not exceed ${BULK_LIMIT_MAX} entries` };
		if (raw.ids.some((id) => typeof id !== 'string' || id.length === 0)) return { error: 'ids must be non-empty strings' };
		return { input: { kind: 'ids', ids: raw.ids as string[] } };
	}

	for (const name of ['binding', 'state', 'unique_key', 'concurrency_key'] as const) {
		if (raw[name] !== undefined && typeof raw[name] !== 'string') return { error: `${name} must be a string` };
	}
	if (typeof raw.state === 'string' && !allowed.includes(raw.state)) {
		return { error: `state must be one of ${allowed.join(', ')} for ${action}` };
	}

	for (const name of ['created_from', 'created_to', 'limit'] as const) {
		if (raw[name] !== undefined && !Number.isInteger(raw[name])) return { error: `${name} must be an integer` };
	}
	if (typeof raw.limit === 'number' && raw.limit < 1) return { error: 'limit must be at least 1' };

	return {
		input: {
			kind: 'filter',
			states: typeof raw.state === 'string' ? [raw.state] : allowed,
			limit: Math.min(typeof raw.limit === 'number' ? raw.limit : BULK_LIMIT_MAX, BULK_LIMIT_MAX),
			...(typeof raw.binding === 'string' && raw.binding ? { binding: raw.binding } : {}),
			...(typeof raw.unique_key === 'string' && raw.unique_key ? { uniqueKey: raw.unique_key } : {}),
			...(typeof raw.concurrency_key === 'string' && raw.concurrency_key ? { concurrencyKey: raw.concurrency_key } : {}),
			...(typeof raw.created_from === 'number' ? { createdFrom: raw.created_from } : {}),
			...(typeof raw.created_to === 'number' ? { createdTo: raw.created_to } : {}),
		},
	};
}

const LIST_LIMIT_MAX = 100;
const LIST_LIMIT_DEFAULT = 20;

// 負のlimitはSQLiteで無制限
function boundedInt(raw: string | null, fallback: number, min: number, max: number): number {
	const value = Number(raw);
	if (raw === null || raw === '' || !Number.isSafeInteger(value) || value < min) return fallback;
	return Math.min(value, max);
}

/** 上限変更漏れ防止で両一覧共通 */
export function parsePaging(url: URL): { limit: number; offset: number } {
	return {
		limit: boundedInt(url.searchParams.get('limit'), LIST_LIMIT_DEFAULT, 1, LIST_LIMIT_MAX),
		offset: boundedInt(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER),
	};
}

export type JobFilters = {
	id?: string;
	uniqueKey?: string;
	concurrencyKey?: string;
	/** created_atの下限, 上限, 両端含む */
	createdFrom?: number;
	createdTo?: number;
};

/**
 * 数値以外の指定は無視, 400では入力途中で画面停止
 * 完全一致のみ, 部分一致はインデックス不使用で件数増加時に全表走査
 */
export function parseJobFilters(url: URL): JobFilters {
	const text = (name: string) => url.searchParams.get(name) || undefined;
	const time = (name: string) => {
		const raw = url.searchParams.get(name);
		// 空文字は指定なし扱い, Number('')は0で上限が1970年
		if (raw === null || raw === '') return undefined;
		const value = Number(raw);
		return Number.isInteger(value) ? value : undefined;
	};

	return {
		...(text('id') ? { id: text('id') as string } : {}),
		...(text('unique_key') ? { uniqueKey: text('unique_key') as string } : {}),
		...(text('concurrency_key') ? { concurrencyKey: text('concurrency_key') as string } : {}),
		...(time('created_from') !== undefined ? { createdFrom: time('created_from') as number } : {}),
		...(time('created_to') !== undefined ? { createdTo: time('created_to') as number } : {}),
	};
}
