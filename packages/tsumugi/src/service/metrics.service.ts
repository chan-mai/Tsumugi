import { MetricsQueryError, readMetrics } from '../analytics/reader.js';
import type { ServiceEnv, ServiceOptions, Unavailable } from './types.js';

type MetricsQuery = Parameters<typeof readMetrics>[1];
type Metrics = Awaited<ReturnType<typeof readMetrics>>;

export function createMetricsService<Env extends ServiceEnv>({ metrics }: ServiceOptions<Env>) {
	return {
		async read(
			env: Env,
			query: MetricsQuery,
		): Promise<{ ok: true; metrics: Metrics } | Unavailable | { ok: false; reason: 'upstream'; message: string }> {
			const config = metrics?.(env);
			if (!config) return { ok: false, reason: 'unavailable' };
			try {
				return { ok: true, metrics: await readMetrics(config, query) };
			} catch (error) {
				if (error instanceof MetricsQueryError) return { ok: false, reason: 'upstream', message: error.message };
				throw error;
			}
		},
	};
}
