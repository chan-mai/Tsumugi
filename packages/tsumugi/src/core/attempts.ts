export type AttemptRecord = {
	attempt: number;
	state: string;
	started_at: number | null;
	finished_at: number;
	error: string | null;
};

/**
 * 1回目成功時の履歴はジョブ行から導出可能で未保存(ADR-0028)
 * 表示用の保存は1ジョブ当たりDO書き込みが常時1回増加
 */
export function attemptsOf(
	job: { state: string; attempts: number; dispatched_at: number | null; updated_at: number },
	stored: AttemptRecord[],
): AttemptRecord[] {
	if (stored.length > 0) return stored;
	if (job.state !== 'COMPLETED' || job.dispatched_at === null) return [];
	return [
		{
			attempt: job.attempts || 1,
			state: 'COMPLETED',
			started_at: job.dispatched_at,
			finished_at: job.updated_at,
			error: null,
		},
	];
}
