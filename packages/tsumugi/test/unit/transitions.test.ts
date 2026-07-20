import { describe, expect, it } from 'vitest';
import {
	ACTIVE_STATES,
	InvalidTransitionError,
	TERMINAL_STATES,
	assertTransition,
	canTransition,
	isActive,
	isTerminal,
} from '../../src/core/transitions.js';
import type { JobState } from '../../src/core/types.js';

const ALL: readonly JobState[] = ['SCHEDULED', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'STALLED'];

/**
 * 許可される遷移をテスト側に独立して書き下し実装の表と突き合わせる
 * 実装の表をimportして比較すると同義反復になるため意図的に二重管理
 */
const ALLOWED = new Set([
	'SCHEDULED->QUEUED',
	'SCHEDULED->CANCELLED',
	'QUEUED->RUNNING',
	'QUEUED->COMPLETED',
	'QUEUED->FAILED',
	'QUEUED->SCHEDULED',
	'QUEUED->STALLED',
	'RUNNING->COMPLETED',
	'RUNNING->FAILED',
	'RUNNING->SCHEDULED',
	'RUNNING->STALLED',
	'FAILED->SCHEDULED',
	'STALLED->SCHEDULED',
]);

describe('遷移表(ADR-0012)', () => {
	it('全49通りが表と一致する', () => {
		const actual: string[] = [];
		for (const from of ALL) {
			for (const to of ALL) {
				if (canTransition(from, to)) actual.push(`${from}->${to}`);
			}
		}
		expect(new Set(actual)).toEqual(ALLOWED);
	});

	it('自己遷移はどの状態でも許さない', () => {
		for (const state of ALL) expect(canTransition(state, state)).toBe(false);
	});

	it('COMPLETEDとCANCELLEDは完全な終端', () => {
		for (const to of ALL) {
			expect(canTransition('COMPLETED', to)).toBe(false);
			expect(canTransition('CANCELLED', to)).toBe(false);
		}
	});

	it('FAILEDとSTALLEDはSCHEDULEDにだけ戻せる(手動リトライ)', () => {
		for (const from of ['FAILED', 'STALLED'] as const) {
			for (const to of ALL) {
				expect(canTransition(from, to)).toBe(to === 'SCHEDULED');
			}
		}
	});

	it('cancelはSCHEDULEDからのみ, QUEUED以降は実行済みかもしれないので嘘をつかない', () => {
		expect(canTransition('SCHEDULED', 'CANCELLED')).toBe(true);
		expect(canTransition('QUEUED', 'CANCELLED')).toBe(false);
		expect(canTransition('RUNNING', 'CANCELLED')).toBe(false);
	});
});

describe('assertTransition', () => {
	it('許可された遷移は通す', () => {
		expect(() => assertTransition('SCHEDULED', 'QUEUED')).not.toThrow();
	});

	it('禁止された遷移はfromとtoを持つ例外を投げる', () => {
		expect(() => assertTransition('COMPLETED', 'SCHEDULED')).toThrow(InvalidTransitionError);
		try {
			assertTransition('COMPLETED', 'SCHEDULED');
		} catch (e) {
			expect(e).toMatchObject({ from: 'COMPLETED', to: 'SCHEDULED' });
		}
	});
});

describe('状態の分類', () => {
	it('稼働中と終端で全状態を過不足なく二分する', () => {
		expect([...ACTIVE_STATES, ...TERMINAL_STATES].sort()).toEqual([...ALL].sort());
	});

	it('isActiveとisTerminalは排他', () => {
		for (const state of ALL) expect(isActive(state)).toBe(!isTerminal(state));
	});

	it('稼働中はスケジューラが扱う3状態', () => {
		expect([...ACTIVE_STATES].sort()).toEqual(['QUEUED', 'RUNNING', 'SCHEDULED']);
	});
});
