import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Performer, type JobContext } from '../../src/core/api.js';
import type { DispatchMessage } from '../../src/do/job-shard.js';
import { handleBatch, type ConsumerEnv } from '../../src/queue/consumer.js';

const consumerEnv: ConsumerEnv = env;

/** 実行されたjobIdを控える, ackだけでなく実行の有無を検証するため */
const performed: string[] = [];
class Ok extends Performer<unknown, void, {}, ConsumerEnv> {
	async perform(_payload: unknown, ctx: JobContext): Promise<void> {
		performed.push(ctx.jobId);
	}
}
const registry = { OK: Ok };

beforeEach(() => {
	performed.length = 0;
});

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
		// 壊れた本文はperformerを実行しない, 正常なメッセージだけが1回実行される
		expect(performed).toEqual(['OK#0:valid']);
		// 同じバッチの正常なメッセージは巻き添えにならない
		expect(valid.ack).toHaveBeenCalledTimes(1);
	});

	it('jobIdが無い本文はperformerを実行せずackする', async () => {
		// bodyはオブジェクトだがjobIdが欠けている, claimRequired無しでも実行経路に入れない
		const noId = message({ binding: 'OK', attempt: 1, payload: {}, timeoutMs: 60_000, claimRequired: false });

		await expect(handleBatch(batchOf([noId]), consumerEnv, registry)).resolves.toBeUndefined();

		expect(performed).toEqual([]);
		expect(noId.ack).toHaveBeenCalledTimes(1);
		expect(noId.retry).not.toHaveBeenCalled();
	});
});

describe('reportの失敗(ADR-0004)', () => {
	it('reportがthrowしてもackは行われQueuesのリトライに乗らない', async () => {
		const report = vi.fn(async () => {
			throw new Error('DO到達不能');
		});
		const failingEnv = {
			JOB_SHARD: {
				idFromName: (name: string) => name,
				get: () => ({ claim: async () => true, report }),
			},
		} as unknown as ConsumerEnv;

		const msg = message(validBody);
		await expect(handleBatch(batchOf([msg]), failingEnv, registry)).resolves.toBeUndefined();

		// performerは実行され, 成功をreportしようとして失敗する
		expect(performed).toEqual(['OK#0:valid']);
		expect(report).toHaveBeenCalledTimes(1);
		expect(report).toHaveBeenCalledWith('OK#0:valid', { ok: true });
		// 報告が失われてもackはする, ジョブはQUEUEDのまま残りreaperが拾う
		expect(msg.ack).toHaveBeenCalledTimes(1);
		expect(msg.retry).not.toHaveBeenCalled();
	});
});
