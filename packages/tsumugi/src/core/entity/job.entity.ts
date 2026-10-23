import type { JobLogEntry } from '../log.js';

export type Attempt = {
	attempt: number;
	state: string;
	startedAt: number | null;
	finishedAt: number;
	error: string | null;
};

export type Job = {
	id: string;
	binding: string;
	state: string;
	priority: number;
	attempts: number;
	maxAttempts: number;
	concurrencyKey: string | null;
	uniqueKey: string | null;
	guarantee: string;
	createdAt: number;
	updatedAt: number;
	dispatchedAt: number | null;
	runAfter: number | null;
	expiresAt: number | null;
	cancelRequestedAt: number | null;
	progress: number | null;
	traceparent: string | null;
	logs: JobLogEntry[];
	payload: string;
	result: string | null;
	runId: string | null;
	nodeId: string | null;
	attemptsLog: Attempt[];
};

export type JobListItem = Pick<
	Job,
	'id' | 'binding' | 'state' | 'priority' | 'attempts' | 'maxAttempts' | 'createdAt' | 'updatedAt' | 'dispatchedAt'
>;

export const JOB_SORT_KEYS = ['updatedAt', 'createdAt', 'binding', 'state', 'priority', 'attempts'] as const;

export type JobSortKey = (typeof JOB_SORT_KEYS)[number];
