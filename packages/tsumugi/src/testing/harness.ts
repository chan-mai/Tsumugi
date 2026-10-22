import { toFailOptions, type FailOptions, type JobContext, type PerformerLike, type Requirements } from '../core/api.js';
import { assertNodeId } from '../core/flow.js';
import { LOG_KEEP, LOG_MAX_CHARS } from '../core/log.js';
import type { SpawnRequest } from '../core/run.js';
import { normalizeTraceparent } from '../core/trace.js';

// DOを含む検証は`@cloudflare/vitest-pool-workers`の対象

export type TestContext = JobContext & {
	logs: string[];
	/** performが要求した子, 要求順(ADR-0032) */
	spawns: SpawnRequest[];
	/** `heartbeat`へ渡された進捗, 実行順, 省略時はundefined */
	heartbeats: (number | undefined)[];
	/** 実行途中の取り消し要求の模擬, 以後のheartbeatはcancelRequested: true(#95) */
	requestCancel(): void;
	/** `fail`の指定, 実行順, 本番は最後が有効(#91) */
	fails: FailOptions[];
};

export type TestContextOptions = {
	traceparent?: string;
	jobId?: string;
	attempt?: number;
	idempotencyKey?: string;
	/** timeout期限時刻, 既定は現在時刻+60秒 */
	deadlineAt?: number;
	/** 開始時点で取り消し要求済み(#95) */
	cancelRequested?: boolean;
};

export function createTestContext(options: TestContextOptions = {}): TestContext {
	const jobId = options.jobId ?? 'TEST#0:testjob000000000000000000';
	// 本番と同じく保持のみ, 投入はDO側(ADR-0031)
	const spawns: SpawnRequest[] = [];
	const heartbeats: (number | undefined)[] = [];
	const logs: string[] = [];
	let cancelRequested = options.cancelRequested ?? false;
	const fails: FailOptions[] = [];

	return {
		jobId,
		traceparent: normalizeTraceparent(options.traceparent),
		logs,
		log: async (message) => {
			logs.push(message.slice(0, LOG_MAX_CHARS));
			if (logs.length > LOG_KEEP) logs.shift();
		},
		attempt: options.attempt ?? 1,
		// 本番と同じくジョブID, 再試行間で同値
		idempotencyKey: options.idempotencyKey ?? jobId,
		deadlineAt: options.deadlineAt ?? Date.now() + 60_000,
		spawns,
		heartbeats,
		heartbeat: async (progress) => {
			heartbeats.push(progress);
			return { cancelRequested };
		},
		requestCancel: () => {
			cancelRequested = true;
		},
		spawn: (id, binding, payload, options) => {
			// consumerと同じID検証
			assertNodeId(id);
			spawns.push({ id, binding, payload, ...(options ? { options } : {}) });
		},
		fails,
		// consumerと同じ形式検証
		fail: (options) => {
			fails.push(toFailOptions(options));
		},
	};
}

export type PerformResult<Result> = { ok: true; value: Result } | { ok: false; error: unknown };

export async function runPerformer<Payload, Result, Req extends Requirements>(
	performer: PerformerLike<Payload, Result, Req>,
	payload: Payload,
	ctx: JobContext = createTestContext(),
): Promise<PerformResult<Result>> {
	try {
		return { ok: true, value: await performer.perform(payload, ctx) };
	} catch (error) {
		return { ok: false, error };
	}
}
