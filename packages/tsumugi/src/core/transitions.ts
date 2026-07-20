import type { ActiveState, JobState } from './types.js';

/**
 * 状態機械の遷移表(ADR-0012)
 * 重複配送や競合で終端状態のジョブが再び動き出さないための番人
 * cancelをSCHEDULEDからのみ許すのは意図的, QUEUED以降は実行済みかもしれず「取り消せた」と嘘をつきたくない
 */
export const TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
	// dispatch / cancel
	SCHEDULED: ['QUEUED', 'CANCELLED'],
	// claim(at-most-onceのみ) /完了報告/ reaper
	QUEUED: ['RUNNING', 'COMPLETED', 'FAILED', 'SCHEDULED', 'STALLED'],
	// 完了報告/ reaper
	RUNNING: ['COMPLETED', 'FAILED', 'SCHEDULED', 'STALLED'],
	COMPLETED: [],
	// ダッシュボードからの手動リトライ
	FAILED: ['SCHEDULED'],
	CANCELLED: [],
	// 沈黙して回収できなかったジョブ,人手で判断して再投入
	STALLED: ['SCHEDULED'],
} as const;

export const ACTIVE_STATES: readonly ActiveState[] = ['SCHEDULED', 'QUEUED', 'RUNNING'];

export const TERMINAL_STATES: readonly JobState[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'STALLED'];

export function isActive(state: JobState): state is ActiveState {
	return state === 'SCHEDULED' || state === 'QUEUED' || state === 'RUNNING';
}

/** 終端判定, FAILEDとSTALLEDは手動復帰できるので終端だが不可逆ではない */
export function isTerminal(state: JobState): boolean {
	return !isActive(state);
}

export function canTransition(from: JobState, to: JobState): boolean {
	return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
	constructor(
		readonly from: JobState,
		readonly to: JobState,
	) {
		super(`不正な状態遷移: ${from} -> ${to}`);
		this.name = 'InvalidTransitionError';
	}
}

export function assertTransition(from: JobState, to: JobState): void {
	if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
