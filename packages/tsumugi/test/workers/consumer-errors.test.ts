import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobContext } from '../../src/core/api.js';
import type { DispatchMessage } from '../../src/do/job-shard.js';
import { handleBatch, type ConsumerEnv } from '../../src/queue/consumer.js';

const consumerEnv: ConsumerEnv = env;

const performed: string[] = [];
const performers = {
	OK: {
		perform: async (_payload: unknown, ctx: JobContext): Promise<void> => {
			performed.push(ctx.jobId);
		},
	},
};

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
		// consumerはretry不使用, 呼び出し時はQueuesリトライ発生(ADR-0004)
		retry: vi.fn(() => {
			throw new Error('retry must not be called');
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
	expiresAt: null,
};

describe('壊れたメッセージ(ADR-0004)', () => {
	it('本文がnullでもackされ, 例外が同じバッチの他メッセージを巻き込まない', async () => {
		const broken = message(null);
		const valid = message(validBody);

		await expect(handleBatch(batchOf([broken, valid]), consumerEnv, performers)).resolves.toBeUndefined();

		// 分割代入がtryの外にあると本文nullの例外でackに未到達
		expect(broken.ack).toHaveBeenCalledTimes(1);
		expect(broken.retry).not.toHaveBeenCalled();
		expect(performed).toEqual(['OK#0:valid']);
		expect(valid.ack).toHaveBeenCalledTimes(1);
	});

	it('jobIdが無い本文はperformerを実行せずackする', async () => {
		const noId = message({ binding: 'OK', attempt: 1, payload: {}, timeoutMs: 60_000, claimRequired: false });

		await expect(handleBatch(batchOf([noId]), consumerEnv, performers)).resolves.toBeUndefined();

		expect(performed).toEqual([]);
		expect(noId.ack).toHaveBeenCalledTimes(1);
		expect(noId.retry).not.toHaveBeenCalled();
	});
});

describe('reportの失敗(ADR-0004)', () => {
	it('reportがthrowしてもackは行われQueuesのリトライに乗らない', async () => {
		const report = vi.fn(async () => {
			throw new Error('DO unreachable');
		});
		const failingEnv = {
			JOB_SHARD: {
				idFromName: (name: string) => name,
				get: () => ({ claim: async () => true, report }),
			},
		} as unknown as ConsumerEnv;

		const msg = message(validBody);
		await expect(handleBatch(batchOf([msg]), failingEnv, performers)).resolves.toBeUndefined();

		expect(performed).toEqual(['OK#0:valid']);
		expect(report).toHaveBeenCalledTimes(1);
		expect(report).toHaveBeenCalledWith('OK#0:valid', { ok: true });
		// 報告喪失時もack, QUEUEDのジョブはreaperが再処理
		expect(msg.ack).toHaveBeenCalledTimes(1);
		expect(msg.retry).not.toHaveBeenCalled();
	});
});
