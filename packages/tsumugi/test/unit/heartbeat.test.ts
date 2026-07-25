import { describe, expect, it } from 'vitest';
import { createHeartbeat, HEARTBEAT_MIN_INTERVAL_MS } from '../../src/queue/consumer.js';

/** 呼び出しを記録する送信口, 時刻は明示的に進める */
function harness() {
	const sent: (number | undefined)[] = [];
	let at = 1_000_000;
	const heartbeat = createHeartbeat(
		async (progress) => {
			sent.push(progress);
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

	it('下限に満たない間隔の呼び出しは捨てる', async () => {
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
		await expect(heartbeat()).resolves.toBeUndefined();
	});
});
