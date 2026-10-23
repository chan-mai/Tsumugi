import type { ActiveState, JobState } from './types.js';

/**
 * 重複配送や競合による終端ジョブ再開防止(ADR-0012)
 * QUEUED以降のcancelは即時遷移でなく協調的要求, 実行済みの可能性あり(ADR-0052)
 * QUEUED, RUNNINGからのCANCELLEDは期限切れ(ADR-0047)と取り消し確定(ADR-0052)のみ
 */
export const TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
	// dispatch, cancel, 期限切れ
	SCHEDULED: ['QUEUED', 'CANCELLED'],
	// claim, 開始通知, 完了報告, reaper, 期限切れ
	QUEUED: ['RUNNING', 'COMPLETED', 'FAILED', 'SCHEDULED', 'STALLED', 'CANCELLED'],
	// 完了報告, reaper, 期限超過再試行の中止
	RUNNING: ['COMPLETED', 'FAILED', 'SCHEDULED', 'STALLED', 'CANCELLED'],
	COMPLETED: [],
	// ダッシュボードから手動リトライ
	FAILED: ['SCHEDULED'],
	CANCELLED: [],
	// 無応答で回収不能, 人手判断で再投入
	STALLED: ['SCHEDULED'],
} as const;

export const ACTIVE_STATES: readonly ActiveState[] = ['SCHEDULED', 'QUEUED', 'RUNNING'];
export const TERMINAL_STATES: readonly JobState[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'STALLED'];
export const FAILURE_STATES: readonly JobState[] = ['FAILED', 'STALLED'];
export const RETRYABLE_STATES = ['FAILED', 'STALLED'] as const satisfies readonly JobState[];
export const CANCELLABLE_STATES = ['SCHEDULED', 'QUEUED', 'RUNNING'] as const satisfies readonly JobState[];

export function isActive(state: JobState): state is ActiveState {
	return state === 'SCHEDULED' || state === 'QUEUED' || state === 'RUNNING';
}

/** FAILED, STALLEDは終端だが手動復帰可能 */
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
