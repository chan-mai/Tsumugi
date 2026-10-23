import type { Attempt } from './job.entity.js';

export type Run = {
	id: string;
	flow: string;
	state: string;
	input: string;
	nodeTotal: number;
	nodeDone: number;
	nodeFailed: number;
	createdAt: number;
	updatedAt: number;
	parentRunId: string | null;
	parentNodeId: string | null;
};

export type RunListItem = Omit<Run, 'input' | 'parentRunId' | 'parentNodeId'>;

export type RunNode = {
	id: string;
	binding: string;
	state: string;
	container: boolean;
	parent: string | null;
	origin: string;
	after: string[];
	jobId: string | null;
	childRunId: string | null;
	result: string | null;
	error: string | null;
	position: number;
	createdAt: number;
	updatedAt: number;
	queuedAt: number | null;
	runAfter: number | null;
	startedAt: number | null;
	finishedAt: number | null;
	attempts: Attempt[];
};
