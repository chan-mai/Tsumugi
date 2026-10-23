import { describe, expect, it } from 'vitest';
import { jobRetryable, runRetryable } from '../../src/core/retention.js';
import { CANCELLABLE_STATES, RETRYABLE_STATES, canTransition } from '../../src/core/transitions.js';

const NOW = 1_000_000;
const KEEP = 60_000;

describe('ジョブのretryable(ADR-0027)', () => {
	it('FAILEDとSTALLEDのみ対象', () => {
		for (const state of ['SCHEDULED', 'QUEUED', 'RUNNING', 'COMPLETED', 'CANCELLED']) {
			expect(jobRetryable({ state, updatedAt: NOW }, NOW, KEEP), state).toBe(false);
		}
		expect(jobRetryable({ state: 'FAILED', updatedAt: NOW }, NOW, KEEP)).toBe(true);
		expect(jobRetryable({ state: 'STALLED', updatedAt: NOW }, NOW, KEEP)).toBe(true);
	});

	it('保持期間を過ぎた行は対象外', () => {
		expect(jobRetryable({ state: 'FAILED', updatedAt: NOW - KEEP + 1 }, NOW, KEEP)).toBe(true);
		// 境界は削除済みとして扱う
		expect(jobRetryable({ state: 'FAILED', updatedAt: NOW - KEEP }, NOW, KEEP)).toBe(false);
	});

	it('保持期間の指定がなければ状態のみで判定', () => {
		expect(jobRetryable({ state: 'FAILED', updatedAt: 0 }, NOW, undefined)).toBe(true);
	});
});

describe('runのretryable(ADR-0034)', () => {
	it('FAILEDのみ対象', () => {
		for (const state of ['RUNNING', 'COMPLETED', 'CANCELLED']) {
			expect(runRetryable({ state, updatedAt: NOW }, NOW, KEEP), state).toBe(false);
		}
		expect(runRetryable({ state: 'FAILED', updatedAt: NOW }, NOW, KEEP)).toBe(true);
	});

	it('保持期間を過ぎたrunは対象外', () => {
		expect(runRetryable({ state: 'FAILED', updatedAt: NOW - KEEP }, NOW, KEEP)).toBe(false);
		expect(runRetryable({ state: 'FAILED', updatedAt: 0 }, NOW, undefined)).toBe(true);
	});
});

describe('操作の受理状態', () => {
	it('リトライの受理状態はSCHEDULEDへ遷移可能', () => {
		for (const state of RETRYABLE_STATES) expect(canTransition(state, 'SCHEDULED'), state).toBe(true);
	});

	it('取り消しの受理状態はCANCELLEDへ遷移可能', () => {
		for (const state of CANCELLABLE_STATES) expect(canTransition(state, 'CANCELLED'), state).toBe(true);
	});
});
