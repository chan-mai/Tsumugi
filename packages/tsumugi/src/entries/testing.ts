// 利用者が自分のperformerやポリシーをテストするための道具
// スケジューラは時刻も乱数も引数で受け取る純粋関数なので,そのまま公開できる(ADR-0018)
export { schedule, effectivePriority } from '../core/schedule.js';
export { nextAttempt } from '../core/backoff.js';
export type { NextAttempt } from '../core/backoff.js';
export { ACTIVE_STATES, TERMINAL_STATES, TRANSITIONS, canTransition, isActive, isTerminal } from '../core/transitions.js';
