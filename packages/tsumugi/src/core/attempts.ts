import type { Attempt } from './entity/job.entity.js';

/**
 * 1回目成功時の履歴はジョブ行から導出可能で未保存(ADR-0028)
 * 表示用の保存は1ジョブ当たりDO書き込みが常時1回増加
 */
export function attemptsOf(
	job: { state: string; attempts: number; dispatchedAt: number | null; updatedAt: number },
	stored: Attempt[],
): Attempt[] {
	if (stored.length > 0) return stored;
	if (job.state !== 'COMPLETED' || job.dispatchedAt === null) return [];
	return [
		{
			attempt: job.attempts || 1,
			state: 'COMPLETED',
			startedAt: job.dispatchedAt,
			finishedAt: job.updatedAt,
			error: null,
		},
	];
}
