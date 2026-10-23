import type { ScheduleMutationResult, ScheduleTriggerResult, ScheduleView } from '../do/scheduler.js';
import type { ServiceEnv, ServiceOptions, Unavailable } from './types.js';

// 定義と状態はScheduler DOが正で直接照会(ADR-0040)
export function createScheduleService<Env extends ServiceEnv>({ schedulerFor }: ServiceOptions<Env>) {
	return {
		async list(env: Env): Promise<{ ok: true; schedules: ScheduleView[] } | Unavailable> {
			if (!schedulerFor) return { ok: false, reason: 'unavailable' };
			return { ok: true, schedules: await schedulerFor(env).list() };
		},

		async setPaused(env: Env, name: string, paused: boolean): Promise<ScheduleMutationResult | Unavailable> {
			if (!schedulerFor) return { ok: false, reason: 'unavailable' };
			return schedulerFor(env).setPaused(name, paused);
		},

		// 一時停止中も実行可, 次回予定は不変
		async trigger(env: Env, name: string): Promise<ScheduleTriggerResult | Unavailable> {
			if (!schedulerFor) return { ok: false, reason: 'unavailable' };
			return schedulerFor(env).trigger(name);
		},
	};
}
