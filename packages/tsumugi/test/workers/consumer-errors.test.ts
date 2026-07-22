import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { Performer } from '../../src/core/api.js';
import type { DispatchMessage } from '../../src/do/job-shard.js';
import { handleBatch, type ConsumerEnv } from '../../src/queue/consumer.js';

const consumerEnv: ConsumerEnv = env;

class Ok extends Performer<unknown, void, {}, ConsumerEnv> {
	async perform(): Promise<void> {}
}
const registry = { OK: Ok };

type FakeMessage = {
	id: string;
	timestamp: Date;
	body: DispatchMessage;
	attempts: number;
	ack: ReturnType<typeof vi.fn>;
	retry: ReturnType<typeof vi.fn>;
};

function message(body: unknown): FakeMessage {
	return {
		id: '0',
		timestamp: new Date(0),
		body: body as DispatchMessage,
		attempts: 1,
		ack: vi.fn(),
		// consumerはretryを呼ばない, 呼べばQueuesのリトライに乗る(ADR-0004)
		retry: vi.fn(() => {
			throw new Error('retryは呼ばれてはならない');
		}),
	};
}

function batchOf(messages: FakeMessage[]) {
	return { queue: 'test', messages, ackAll: () => {}, retryAll: () => {} } as unknown as MessageBatch<DispatchMessage>;
}

const validBody: DispatchMessage = {
	jobId: 'OK#0:valid',
	binding: 'OK',
	attempt: 1,
	payload: {},
	timeoutMs: 60_000,
	claimRequired: false,
};

describe('壊れたメッセージ(ADR-0004)', () => {
	it('本文がnullでもackされ, 例外が同じバッチの他メッセージを巻き込まない', async () => {
		const broken = message(null);
		const valid = message(validBody);

		await expect(handleBatch(batchOf([broken, valid]), consumerEnv, registry)).resolves.toBeUndefined();

		// 分割代入がtryの外にあると本文nullで例外が出てackに到達しない
		expect(broken.ack).toHaveBeenCalledTimes(1);
		expect(broken.retry).not.toHaveBeenCalled();
		// 同じバッチの正常なメッセージは巻き添えにならない
		expect(valid.ack).toHaveBeenCalledTimes(1);
	});
});

describe('reportの失敗(ADR-0004)', () => {
	it('reportがthrowしてもackは行われQueuesのリトライに乗らない', async () => {
		const failingEnv = {
			JOB_SHARD: {
				idFromName: (name: string) => name,
				get: () => ({
					claim: async () => true,
					report: async () => {
						throw new Error('DO到達不能');
					},
				}),
			},
		} as unknown as ConsumerEnv;

		const msg = message(validBody);
		await expect(handleBatch(batchOf([msg]), failingEnv, registry)).resolves.toBeUndefined();

		// 報告が失われてもackはする, ジョブはQUEUEDのまま残りreaperが拾う
		expect(msg.ack).toHaveBeenCalledTimes(1);
		expect(msg.retry).not.toHaveBeenCalled();
	});
});
