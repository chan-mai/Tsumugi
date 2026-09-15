import type { JobContext, PerformerLike, Requirements } from '../core/api.js';
import { assertNodeId } from '../core/flow.js';
import { LOG_KEEP, LOG_MAX_CHARS } from '../core/log.js';
import type { SpawnRequest } from '../core/run.js';
import { normalizeTraceparent } from '../core/trace.js';

/**
 * performerを試すための道具
 *
 * DOもQueuesも起動せずにperformを直接呼ぶ
 * DOを含む検証は`@cloudflare/vitest-pool-workers`の領域で対象外
 */

export type TestContext = JobContext & {
	logs: string[];
	/** performが要求した子, 要求の順に入る(ADR-0032) */
	spawns: SpawnRequest[];
	/** `heartbeat`へ渡された進捗, 実行の順に入り省略時はundefined */
	heartbeats: (number | undefined)[];
};

export type TestContextOptions = {
	traceparent?: string;
	jobId?: string;
	attempt?: number;
	idempotencyKey?: string;
	/** timeoutが切れる時刻, 既定は現在時刻から60秒後 */
	deadlineAt?: number;
};

/** `JobContext`の構築 */
export function createTestContext(options: TestContextOptions = {}): TestContext {
	const jobId = options.jobId ?? 'TEST#0:testjob000000000000000000';
	// 本番と同じく保持のみ, 実際の投入はDO側で発生(ADR-0031)
	const spawns: SpawnRequest[] = [];
	// 本番はDOへ送信するが、ここでは実行の記録だけを残す
	const heartbeats: (number | undefined)[] = [];
	const logs: string[] = [];

	return {
		jobId,
		traceparent: normalizeTraceparent(options.traceparent),
		logs,
		log: async (message) => {
			logs.push(message.slice(0, LOG_MAX_CHARS));
			if (logs.length > LOG_KEEP) logs.shift();
		},
		attempt: options.attempt ?? 1,
		// 実装と同じくジョブIDをそのまま使用, 再試行を跨いで同値
		idempotencyKey: options.idempotencyKey ?? jobId,
		deadlineAt: options.deadlineAt ?? Date.now() + 60_000,
		spawns,
		heartbeats,
		heartbeat: async (progress) => {
			heartbeats.push(progress);
		},
		spawn: (id, binding, payload, options) => {
			// consumerと同じID検証
			assertNodeId(id);
			spawns.push({ id, binding, payload, ...(options ? { options } : {}) });
		},
	};
}

export type PerformResult<Result> = { ok: true; value: Result } | { ok: false; error: unknown };

/**
 * performを呼び、例外を投げずに結果として返す
 * 本番では例外がそのままリトライの判断材料, 投げたか否かを同じ形で確認可能
 */
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
