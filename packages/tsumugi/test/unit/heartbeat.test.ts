import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHeartbeat, HEARTBEAT_MIN_INTERVAL_MS } from '../../src/queue/consumer.js';

/** 呼び出しを記録する送信口, 時刻は明示的に進める */
function harness() {
	const sent: (number | undefined)[] = [];
	let at = 1_000_000;
	const heartbeat = createHeartbeat(
		async (progress) => {
			sent.push(progress);
			return { accepted: true, cancelRequested: false };
		},
		() => at,
	);
	return { sent, heartbeat, advance: (ms: number) => (at += ms) };
}

describe('生存報告の間引き', () => {
	it('最初の呼び出しは送る', async () => {
		const { sent, heartbeat } = harness();
		await heartbeat(0.5);
		expect(sent).toEqual([0.5]);
	});

	it('下限に満たない間隔の呼び出しは破棄する', async () => {
		// performerが1秒ごとに呼んでもDOへの書き込みは増えない
		const { sent, heartbeat, advance } = harness();
		await heartbeat();
		for (let i = 0; i < 4; i++) {
			advance(1_000);
			await heartbeat();
		}
		expect(sent).toHaveLength(1);
	});

	it('下限を超えれば再び送る', async () => {
		const { sent, heartbeat, advance } = harness();
		await heartbeat(0.1);
		advance(HEARTBEAT_MIN_INTERVAL_MS);
		await heartbeat(0.9);
		expect(sent).toEqual([0.1, 0.9]);
	});

	it('送信が失敗しても呼び出し側へ投げない', async () => {
		// 報告が届かなくてもreaperが回収するだけで実行自体は続く
		const heartbeat = createHeartbeat(
			async () => {
				throw new Error('unreachable');
			},
			() => 0,
		);
		await expect(heartbeat()).resolves.toEqual({ cancelRequested: false });
	});

	it('送信が滞っても待機は上限で切り上げる', async () => {
		// DOが応答しない場合にperformerの処理を止めない
		const heartbeat = createHeartbeat(
			() => new Promise(() => {}),
			() => 0,
			HEARTBEAT_MIN_INTERVAL_MS,
			10,
		);
		await expect(heartbeat()).resolves.toEqual({ cancelRequested: false });
	});

	it('送信が同期的に例外を送出しても呼び出し側へ投げない', async () => {
		const heartbeat = createHeartbeat(
			() => {
				throw new Error('unreachable');
			},
			() => 0,
		);
		await expect(heartbeat()).resolves.toEqual({ cancelRequested: false });
	});

	describe('待機の上限のタイマー', () => {
		afterEach(() => void vi.useRealTimers());

		it('送信が先に終われば解除する', async () => {
			// 未解除では呼び出しごとにタイマーが増加, 上限の経過まで保持
			vi.useFakeTimers();
			const { heartbeat } = harness();
			await heartbeat();
			expect(vi.getTimerCount()).toBe(0);
		});
	});
});

describe('取り消し要求の伝達(#95)', () => {
	function cancellable(initial: boolean) {
		let requested = initial;
		let at = 1_000_000;
		const heartbeat = createHeartbeat(
			async () => ({ accepted: true, cancelRequested: requested }),
			() => at,
		);
		return { heartbeat, advance: (ms: number) => (at += ms), request: () => void (requested = true) };
	}

	it('応答のcancelRequestedがそのまま戻り値になる', async () => {
		const { heartbeat, advance, request } = cancellable(false);
		await expect(heartbeat()).resolves.toEqual({ cancelRequested: false });
		request();
		advance(HEARTBEAT_MIN_INTERVAL_MS);
		await expect(heartbeat()).resolves.toEqual({ cancelRequested: true });
	});

	it('一度trueになれば間引かれた報告でも戻り値はtrue', async () => {
		const { heartbeat, advance } = cancellable(true);
		await heartbeat();
		advance(1_000);
		// 下限未満で送信は無く戻り値は直近の結果
		await expect(heartbeat()).resolves.toEqual({ cancelRequested: true });
	});

	it('不受理の応答はcancelRequestedをtrueにする', async () => {
		const heartbeat = createHeartbeat(
			async () => ({ accepted: false, cancelRequested: false }),
			() => 0,
		);
		await expect(heartbeat()).resolves.toEqual({ cancelRequested: true });
	});

	it('待機の上限を超えた応答は次の報告の戻り値に反映される', async () => {
		let release: (() => void) | undefined;
		let at = 1_000_000;
		const heartbeat = createHeartbeat(
			() =>
				new Promise((resolve) => {
					release = () => resolve({ accepted: true, cancelRequested: true });
				}),
			() => at,
			HEARTBEAT_MIN_INTERVAL_MS,
			10,
		);
		await expect(heartbeat()).resolves.toEqual({ cancelRequested: false });
		release!();
		await new Promise((resolve) => setTimeout(resolve, 0));
		at += HEARTBEAT_MIN_INTERVAL_MS;
		await expect(heartbeat()).resolves.toEqual({ cancelRequested: true });
	});
});
