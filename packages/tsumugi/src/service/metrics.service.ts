import { MetricsQueryError, readMetrics, type MetricsResolver } from '../analytics/reader.js';
import type { ServiceEnv, ServiceOptions } from './types.js';

type MetricsConfig = NonNullable<ReturnType<MetricsResolver>>;
type MetricsQuery = Parameters<typeof readMetrics>[1];
type Metrics = Awaited<ReturnType<typeof readMetrics>>;

export function createMetricsService<Env extends ServiceEnv>({ metrics }: ServiceOptions<Env>) {
	return {
		// クエリの検証より先に判定
		configOf(env: Env): MetricsConfig | null {
			return metrics?.(env) ?? null;
		},

		async read(config: MetricsConfig, query: MetricsQuery): Promise<{ ok: true; metrics: Metrics } | { ok: false; message: string }> {
			try {
				return { ok: true, metrics: await readMetrics(config, query) };
			} catch (error) {
				if (error instanceof MetricsQueryError) return { ok: false, message: error.message };
				throw error;
			}
		},
	};
}
