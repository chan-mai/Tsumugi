import type { ActiveState, JobState } from './types.js';

/**
 * 状態機械の遷移表(ADR-0012)
 * 重複配送や競合で終端状態のジョブが再び動き出すのを防止
 * QUEUED以降のcancelは即時遷移せず協調的な要求として扱う(ADR-0052), 実行済みの可能性があり取り消し成功の保証が不可能
 * QUEUED / RUNNINGからのCANCELLEDは期限切れ(ADR-0047)と取り消し要求後の確定(ADR-0052)に限定
 */
export const TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
	// dispatch / cancel /期限切れ
	SCHEDULED: ['QUEUED', 'CANCELLED'],
	// claim(at-most-onceのみ) /完了報告/ reaper /期限切れ
	QUEUED: ['RUNNING', 'COMPLETED', 'FAILED', 'SCHEDULED', 'STALLED', 'CANCELLED'],
	// 完了報告/ reaper /期限を越える再試行の中止
	RUNNING: ['COMPLETED', 'FAILED', 'SCHEDULED', 'STALLED', 'CANCELLED'],
	COMPLETED: [],
	// ダッシュボードからの手動リトライ
	FAILED: ['SCHEDULED'],
	CANCELLED: [],
	// 無応答で回収できなかったジョブ, 人手で判断して再投入
	STALLED: ['SCHEDULED'],
} as const;

export const ACTIVE_STATES: readonly ActiveState[] = ['SCHEDULED', 'QUEUED', 'RUNNING'];

export const TERMINAL_STATES: readonly JobState[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'STALLED'];

export function isActive(state: JobState): state is ActiveState {
	return state === 'SCHEDULED' || state === 'QUEUED' || state === 'RUNNING';
}

/** 終端判定, FAILEDとSTALLEDは終端だが手動復帰が可能 */
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
		super(`invalid state transition: ${from} -> ${to}`);
		this.name = 'InvalidTransitionError';
	}
}

export function assertTransition(from: JobState, to: JobState): void {
	if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
