import { InvalidJobIdError } from '../core/ids.js';
import type { Job, JobListItem } from '../core/entity/job.entity.js';
import { jobRetryable } from '../core/retention.js';
import { mutateJob, mutateJobs, type BulkOutcome } from '../do/control.js';
import type { MutationResult, TsumugiJobShard } from '../do/job-shard.js';
import {
	JobReadRepository,
	type BulkFilter,
	type JobListQuery,
	type JobRepository,
	type RetainedFailures,
} from '../repository/job.repository.js';
import type { CreateJobInput } from './inputs.js';
import type { MutationOutcome, Retryable, ServiceEnv, ServiceOptions } from './types.js';

export type { JobFilters } from '../repository/job.repository.js';

type JobAction = { kind: 'retry' } | { kind: 'cancel' } | { kind: 'reschedule'; runAfter: number; priority?: number };

// 画面はID列挙, 一覧外の件数を扱う利用者は条件指定
export type BulkTarget = { kind: 'ids'; ids: string[] } | ({ kind: 'filter' } & BulkFilter);

type JobStats = { byState: Record<string, number>; oldestScheduledMs: number | null };

export function createJobService<Env extends ServiceEnv>(
	{ bindings, enqueue, failedRetentionMs }: ServiceOptions<Env>,
	repositoryOf: (env: Env) => JobRepository = (env) => new JobReadRepository(env.TSUMUGI_DB),
) {
	const withRetryable = <T extends Pick<Job, 'state' | 'binding' | 'updatedAt'>>(job: T, now: number): Retryable<T> => ({
		...job,
		retryable: jobRetryable(job, now, failedRetentionMs?.(job.binding)),
	});
	const retention: RetainedFailures | undefined = failedRetentionMs ? { of: failedRetentionMs, bindings } : undefined;

	const apply = (id: string, action: JobAction) => (stub: DurableObjectStub<TsumugiJobShard>) => {
		switch (action.kind) {
			case 'retry':
				return stub.retry(id);
			// SCHEDULEDは即時, QUEUED / RUNNINGは要求の受理(ADR-0052)
			case 'cancel':
				return stub.cancel(id);
			// SCHEDULED以外は予定変更でも実行継続, DO側で拒否
			case 'reschedule':
				return stub.reschedule(id, { runAfter: action.runAfter, ...(action.priority !== undefined ? { priority: action.priority } : {}) });
		}
	};

	return {
		async list(env: Env, query: JobListQuery): Promise<{ jobs: Retryable<JobListItem>[]; total: number }> {
			const { jobs, total } = await repositoryOf(env).list(query);
			const now = Date.now();
			return { jobs: jobs.map((job) => withRetryable(job, now)), total };
		},

		async detail(env: Env, id: string): Promise<Retryable<Job> | null> {
			const found = await repositoryOf(env).find(id);
			return found ? withRetryable(found, Date.now()) : null;
		},

		// 分割構成のpartitionKey欠落, binding名の不正は`invalid`
		create: enqueue
			? async (env: Env, input: CreateJobInput): Promise<{ ok: true; id: string } | { ok: false; reason: 'invalid'; message: string }> => {
					try {
						return { ok: true, id: await enqueue(env, input) };
					} catch (error) {
						if (error instanceof InvalidJobIdError) return { ok: false, reason: 'invalid', message: error.message };
						throw error;
					}
				}
			: null,

		async mutate(env: Env, id: string, action: JobAction): Promise<MutationOutcome> {
			let result: MutationResult;
			try {
				result = await mutateJob(env, id, apply(id, action));
			} catch (error) {
				if (error instanceof InvalidJobIdError) return { ok: false, reason: 'invalid-id' };
				throw error;
			}
			if (!result.ok) return result;
			return result.requested ? { ok: true, requested: true } : { ok: true };
		},

		// 対象は読み取りモデルから取得, 横断的な抽出はDOへ問い合わせ不能(ADR-0008)
		// 一部拒否でも全体は成功扱い, 全体失敗では成功分も再送発生
		async bulk(env: Env, action: 'retry' | 'cancel', target: BulkTarget): Promise<BulkOutcome & { remaining: number }> {
			const { ids, remaining } =
				target.kind === 'ids'
					? { ids: target.ids, remaining: 0 }
					: await repositoryOf(env).selectBulkTargets(action, target, retention, Date.now());
			return { ...(await mutateJobs(env, action, ids)), remaining };
		},

		// 読み取りモデル経由で数秒遅延, 傾向把握用
		async stats(env: Env): Promise<JobStats> {
			const { byState, oldestScheduledAt } = await repositoryOf(env).stats();
			return { byState, oldestScheduledMs: oldestScheduledAt === null ? null : Math.max(0, Date.now() - oldestScheduledAt) };
		},
	};
}
