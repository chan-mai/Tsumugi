import { FAILURE_STATES } from '../core/transitions.js';

// `writeDataPoint`の値はWorker bindingから読込不可, アカウントのAPIトークンが必要
// トークンはsecretで`env`経由のみ読込可, 設定形式は`bearerAuth`と同一

// 書き出し側の列対応, `toPoint`と一致必須
const COLUMNS = {
	binding: 'blob2',
	state: 'blob1',
	attempts: 'double1',
	durationMs: 'double2',
} as const;

export type MetricsConfig = {
	accountId: string;
	/** Analytics Engine読み取り権限付きAPIトークン */
	apiToken: string;
	/** `writeDataPoint`の書き出し先, wranglerの`dataset`と一致必須 */
	dataset: string;
};

/** secretは実行時に`env`から取得 */
export type MetricsResolver<Env = any> = (env: Env) => MetricsConfig | undefined;

export type MetricsQuery = {
	/** 遡る時間数, 既定24, 最大720 */
	hours: number;
	binding?: string;
};

export type BindingMetrics = {
	binding: string;
	total: number;
	failed: number;
	/** 0以上1以下 */
	failureRate: number;
	avgDurationMs: number;
	maxDurationMs: number;
	p95DurationMs: number;
	avgAttempts: number;
};

/** 1時間ごとの推移 */
export type MetricsPoint = {
	/** 区間の開始時刻, epochミリ秒 */
	at: number;
	total: number;
	failed: number;
	avgDurationMs: number;
};

export type MetricsResult = {
	hours: number;
	bindings: BindingMetrics[];
	series: MetricsPoint[];
};

export class MetricsQueryError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = 'MetricsQueryError';
	}
}

export function parseMetricsQuery(url: URL): { query: MetricsQuery } | { error: string } {
	const raw = url.searchParams.get('hours');
	const hours = raw === null || raw === '' ? 24 : Number(raw);
	if (!Number.isFinite(hours) || hours < 1) return { error: 'hours must be at least 1' };
	if (hours > 720) return { error: 'hours must not exceed 720' };

	const binding = url.searchParams.get('binding') || undefined;
	// SQLへ直接埋め込み, binding名として有効な文字のみ許可
	if (binding !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding)) return { error: 'binding is not a valid name' };

	return { query: { hours: Math.floor(hours), ...(binding ? { binding } : {}) } };
}

const failedSum = `sum(if(${COLUMNS.state} IN ('${FAILURE_STATES.join("', '")}'), _sample_interval, 0))`;
const totalSum = 'sum(_sample_interval)';

/**
 * サンプリング時1行は`_sample_interval`件分, 件数は`count()`でなくその和
 * 所要時間の平均, 分位も同じ重み付け, 重みなしはサンプリング時に偏り
 */
export function bindingSql({ hours, binding }: MetricsQuery, dataset: string): string {
	const where = binding ? ` AND ${COLUMNS.binding} = '${binding}'` : '';
	return `SELECT
		${COLUMNS.binding} AS binding,
		${totalSum} AS total,
		${failedSum} AS failed,
		sum(${COLUMNS.durationMs} * _sample_interval) / ${totalSum} AS avg_duration,
		max(${COLUMNS.durationMs}) AS max_duration,
		quantileWeighted(0.95)(${COLUMNS.durationMs}, _sample_interval) AS p95_duration,
		sum(${COLUMNS.attempts} * _sample_interval) / ${totalSum} AS avg_attempts
	FROM ${dataset}
	WHERE timestamp > NOW() - INTERVAL '${hours}' HOUR${where}
	GROUP BY binding
	ORDER BY total DESC
	FORMAT JSON`;
}

export function seriesSql({ hours, binding }: MetricsQuery, dataset: string): string {
	const where = binding ? ` AND ${COLUMNS.binding} = '${binding}'` : '';
	return `SELECT
		toStartOfInterval(timestamp, INTERVAL '1' HOUR) AS at,
		${totalSum} AS total,
		${failedSum} AS failed,
		sum(${COLUMNS.durationMs} * _sample_interval) / ${totalSum} AS avg_duration
	FROM ${dataset}
	WHERE timestamp > NOW() - INTERVAL '${hours}' HOUR${where}
	GROUP BY at
	ORDER BY at
	FORMAT JSON`;
}

type SqlRow = Record<string, string | number | null>;

const num = (value: string | number | null | undefined): number => {
	const parsed = typeof value === 'number' ? value : Number(value ?? 0);
	return Number.isFinite(parsed) ? parsed : 0;
};

// subrequestに既定タイムアウトなし
const QUERY_TIMEOUT_MS = 10_000;

async function query(config: MetricsConfig, sql: string, fetchImpl: typeof globalThis.fetch): Promise<SqlRow[]> {
	const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/analytics_engine/sql`, {
		method: 'POST',
		headers: { authorization: `Bearer ${config.apiToken}`, 'content-type': 'text/plain' },
		body: sql,
		signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
	}).catch((error: unknown) => {
		// 無応答も他の失敗と同様にエラー化, Worker実行時間の消費回避
		if (error instanceof DOMException && error.name === 'TimeoutError') {
			throw new MetricsQueryError(504, `analytics engine did not respond within ${QUERY_TIMEOUT_MS}ms`);
		}
		throw error;
	});

	if (!response.ok) {
		// 本文にSQL誤り, トークン不足の詳細, 原因特定用に返却
		const detail = await response.text().catch(() => '');
		throw new MetricsQueryError(response.status, detail.slice(0, 500) || `analytics engine returned ${response.status}`);
	}
	const body = (await response.json()) as { data?: SqlRow[] };
	return body.data ?? [];
}

export async function readMetrics(
	config: MetricsConfig,
	input: MetricsQuery,
	fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<MetricsResult> {
	const [byBinding, overTime] = await Promise.all([
		query(config, bindingSql(input, config.dataset), fetchImpl),
		query(config, seriesSql(input, config.dataset), fetchImpl),
	]);

	return {
		hours: input.hours,
		bindings: byBinding.map((row) => {
			const total = num(row.total);
			const failed = num(row.failed);
			return {
				binding: String(row.binding ?? ''),
				total,
				failed,
				failureRate: total === 0 ? 0 : failed / total,
				avgDurationMs: num(row.avg_duration),
				maxDurationMs: num(row.max_duration),
				p95DurationMs: num(row.p95_duration),
				avgAttempts: num(row.avg_attempts),
			};
		}),
		series: overTime.map((row) => ({
			// SQL APIはUTC文字列, 画面はepochミリ秒
			at: Date.parse(`${String(row.at ?? '')}Z`.replace(' ', 'T')),
			total: num(row.total),
			failed: num(row.failed),
			avgDurationMs: num(row.avg_duration),
		})),
	};
}
