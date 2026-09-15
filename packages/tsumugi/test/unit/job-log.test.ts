import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOG_MAX_CHARS, LOG_MIN_INTERVAL_MS } from '../../src/core/log.js';
import { createLog } from '../../src/queue/consumer.js';

afterEach(() => vi.useRealTimers());

describe('実行ログの送信', () => {
	it('最短間隔を満たす本文だけ送信する', async () => {
		const send = vi.fn(async (_message: string) => true);
		let now = 0;
		const log = createLog(send, () => now);
		await log('started');
		now = LOG_MIN_INTERVAL_MS - 1;
		await log('skipped');
		now++;
		await log('finished');
		expect(send.mock.calls).toEqual([['started'], ['finished']]);
	});

	it('RPC送信前に本文を2,000文字へ制限する', async () => {
		const send = vi.fn(async (_message: string) => true);
		await createLog(send, () => 0)('a'.repeat(LOG_MAX_CHARS + 1));
		expect(send).toHaveBeenCalledWith('a'.repeat(LOG_MAX_CHARS));
	});

	it('並行呼び出しも最短間隔を適用する', async () => {
		const send = vi.fn(async (_message: string) => true);
		const log = createLog(send, () => 0);
		await Promise.all([log('first'), log('second')]);
		expect(send).toHaveBeenCalledTimes(1);
	});

	it.each([false, true])('送信時の例外をperformerへ伝播しない(sync=%s)', async (sync) => {
		const error = new Error('unavailable');
		const log = createLog(
			() => {
				if (sync) throw error;
				return Promise.reject(error);
			},
			() => 0,
		);
		await expect(log('started')).resolves.toBeUndefined();
	});

	it('応答がない場合は1秒で待機を終える', async () => {
		vi.useFakeTimers();
		const log = createLog(
			() => new Promise(() => {}),
			() => Date.now(),
		);
		const pending = log('started');
		await vi.advanceTimersByTimeAsync(1_000);
		await expect(pending).resolves.toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('送信完了時にタイマーを削除する', async () => {
		vi.useFakeTimers();
		await createLog(
			async () => true,
			() => 0,
		)('started');
		expect(vi.getTimerCount()).toBe(0);
	});
});
