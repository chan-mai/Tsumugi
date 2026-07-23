// 利用者が自分のperformerやポリシーをテストするための道具
// スケジューラは時刻も乱数も引数で受け取る純粋関数なので,そのまま公開できる(ADR-0018)
export { schedule, effectivePriority } from '../core/schedule.js';
export { nextAttempt } from '../core/backoff.js';
export type { NextAttempt } from '../core/backoff.js';
export { ACTIVE_STATES, TERMINAL_STATES, TRANSITIONS, canTransition, isActive, isTerminal } from '../core/transitions.js';

// performerを直接呼ぶためのハーネス
export { createTestContext, runPerformer } from '../testing/harness.js';
export type { PerformResult, TestContext, TestContextOptions } from '../testing/harness.js';

// Workersには時間を進めるAPIが無くfake timersもDOに効かないため, 時計は注入して明示的に進める
export { fixedClock } from '../do/clock.js';
export type { Clock } from '../do/clock.js';
