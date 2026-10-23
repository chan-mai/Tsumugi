import { isActive } from './transitions.js';
import type { JobState } from './types.js';

type NodeJobTimes = { state: string; createdAt: number; runAfter: number | null; dispatchedAt: number | null; updatedAt: number };
type NodeChildTimes = { state: string; createdAt: number; updatedAt: number };

type NodeTiming = { queuedAt: number | null; runAfter: number | null; startedAt: number | null; finishedAt: number | null };

// subflowの期間は子runの作成から終端まで
export function nodeTiming(job: NodeJobTimes | null, child: NodeChildTimes | null): NodeTiming {
	return {
		queuedAt: job?.createdAt ?? child?.createdAt ?? null,
		runAfter: job?.runAfter ?? null,
		startedAt: job?.dispatchedAt ?? child?.createdAt ?? null,
		finishedAt: job
			? isActive(job.state as JobState)
				? null
				: job.updatedAt
			: child && child.state !== 'RUNNING'
				? child.updatedAt
				: null,
	};
}
