import { InvalidRunIdError, parseRunId } from '../core/ids.js';
import { runRetryable } from '../core/retention.js';
import type { Run, RunListItem, RunNode } from '../core/entity/run.entity.js';
import { RunReadRepository, type RunListQuery, type RunRepository } from '../repository/run.repository.js';
import type { Retryable } from './jobs.service.js';
import type { MutationOutcome, ServiceEnv, ServiceOptions, StartRunInput, Unavailable } from './types.js';

export function createRunService<Env extends ServiceEnv>(
	{ flows, start, runFor, runFailedRetentionMs }: ServiceOptions<Env>,
	repositoryOf: (env: Env) => RunRepository = (env) => new RunReadRepository(env.TSUMUGI_DB),
) {
	return {
		list(env: Env, query: RunListQuery): Promise<{ runs: RunListItem[]; total: number }> {
			return repositoryOf(env).list(query);
		},

		// 未実行flowも含め`flows`から返却
		flows(): string[] {
			return [...(flows ?? [])].sort();
		},

		async detail(env: Env, id: string): Promise<{ run: Retryable<Run>; nodes: RunNode[] } | null> {
			const found = await repositoryOf(env).find(id);
			if (!found) return null;
			const { run, nodes } = found;
			return { run: { ...run, retryable: runRetryable(run, Date.now(), runFailedRetentionMs) }, nodes };
		},

		async start(env: Env, input: StartRunInput): Promise<{ ok: true; id: string } | Unavailable | { ok: false; reason: 'invalid-id' }> {
			if (!start) return { ok: false, reason: 'unavailable' };
			const { flow, input: runInput, id, deadlineMs } = input;
			try {
				const started = await start(env, flow, runInput, {
					...(id !== undefined ? { id } : {}),
					...(deadlineMs !== undefined ? { deadlineMs } : {}),
				});
				return { ok: true, id: started };
			} catch (error) {
				if (error instanceof InvalidRunIdError) return { ok: false, reason: 'invalid-id' };
				throw error;
			}
		},

		// 取り消し, 再開は正であるRun DOへ送信
		async mutate(env: Env, id: string, action: 'cancel' | 'retry'): Promise<MutationOutcome | Unavailable> {
			if (!runFor) return { ok: false, reason: 'unavailable' };
			try {
				parseRunId(id);
			} catch (error) {
				if (error instanceof InvalidRunIdError) return { ok: false, reason: 'invalid-id' };
				throw error;
			}
			const stub = runFor(env, id);
			const result = action === 'cancel' ? await stub.cancel() : await stub.retry();
			return result.ok ? { ok: true } : result;
		},
	};
}
