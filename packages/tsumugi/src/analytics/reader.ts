/**
 * Analytics EngineのSQL APIから計測点を読む(ADR-0016)
 *
 * `writeDataPoint`で書いた値はWorkerのbindingからは読めず, アカウントのAPIトークンが要る
 * トークンはsecretなので`env`経由でしか読めない, 設定の形は`bearerAuth`と揃える
 */

/** 書き出し側の列の対応, `toPoint`と揃っていないと読む値がずれる */
const COLUMNS = {
	binding: 'blob2',
	state: 'blob1',
	attempts: 'double1',
	durationMs: 'double2',
} as const;

/** 終端の状態のうち失敗として数えるもの */
const FAILED_STATES = ['FAILED', 'STALLED'];

export type MetricsConfig = {
	/** CloudflareのアカウントID */
	accountId: string;
	/** Analytics Engineの読み取り権限を持つAPIトークン */
	apiToken: string;
	/** `writeDataPoint`の書き出し先, wranglerの`dataset`と揃える */
	dataset: string;
};

/** `defineTsumugi`が受け取る形, secretは実行時に`env`から引く */
export type MetricsResolver<Env = any> = (env: Env) => MetricsConfig | undefined;

export type MetricsQuery = {
	/** 遡る時間, 既定24で最大720 */
	hours: number;
	/** binding名での絞り込み */
	binding?: string;
};

/** binding単位の集計 */
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

/** 区間と絞り込みの検証, 通らなければ理由を返す */
export function parseMetricsQuery(url: URL): { query: MetricsQuery } | { error: string } {
	const raw = url.searchParams.get('hours');
	const hours = raw === null || raw === '' ? 24 : Number(raw);
	if (!Number.isFinite(hours) || hours < 1) return { error: 'hours must be at least 1' };
	if (hours > 720) return { error: 'hours must not exceed 720' };

	const binding = url.searchParams.get('binding') || undefined;
	// SQLへ直接差し込むので, binding名として成立する文字だけを通す
	if (binding !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding)) return { error: 'binding is not a valid name' };

	return { query: { hours: Math.floor(hours), ...(binding ? { binding } : {}) } };
}

const failedSum = `sum(if(${COLUMNS.state} IN ('${FAILED_STATES.join("', '")}'), _sample_interval, 0))`;
const totalSum = 'sum(_sample_interval)';

/**
 * binding単位の集計を求めるSQL
 *
 * サンプリングが有効な場合、1行は`_sample_interval`件を代表する
 * 件数は素の`count()`ではなく`_sample_interval`の和で数える
 * 所要時間の平均と分位も同じ重みを掛ける, 掛けないとサンプリング時に偏る
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

/** 1時間ごとの推移を求めるSQL */
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

/** SQL APIへ1本投げて`data`を取り出す */
async function query(config: MetricsConfig, sql: string, fetchImpl: typeof globalThis.fetch): Promise<SqlRow[]> {
	const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/analytics_engine/sql`, {
		method: 'POST',
		headers: { authorization: `Bearer ${config.apiToken}`, 'content-type': 'text/plain' },
		body: sql,
	});

	if (!response.ok) {
		// 本文にはSQLの誤りやトークンの不足が入る, そのまま運ぶと原因が分かる
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
			// SQL APIはUTCの文字列を返す, 画面はepochミリ秒で扱う
			at: Date.parse(`${String(row.at ?? '')}Z`.replace(' ', 'T')),
			total: num(row.total),
			failed: num(row.failed),
			avgDurationMs: num(row.avg_duration),
		})),
	};
}
