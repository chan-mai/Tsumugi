import type { JobContext, Performer, Requirements } from '../core/api.js';
import type { SpawnRequest } from '../core/run.js';

/**
 * performerを試すための道具
 *
 * DOもQueuesも起動せずにperformを直接呼ぶ
 * DOを絡めた検証は`@cloudflare/vitest-pool-workers`の領域なのでここでは扱わない
 */

export type TestContext = JobContext & {
	/** `signal`をabortする, timeoutに協調するperformerを試す時に使う */
	abort(reason?: unknown): void;
	/** performが要求した子, 要求の順に入る(ADR-0032) */
	spawns: SpawnRequest[];
	/** `heartbeat`へ渡された進捗, 実行の順に入り省略時はundefined */
	heartbeats: (number | undefined)[];
};

export type TestContextOptions = {
	jobId?: string;
	attempt?: number;
	idempotencyKey?: string;
	/** 既にabort済みの状態から始める */
	aborted?: boolean;
};

/**
 * `JobContext`を組み立てる
 * `signal`は実物の`AbortController`から取る, 偽物だとperformer側の`addEventListener`が動かない
 */
export function createTestContext(options: TestContextOptions = {}): TestContext {
	const jobId = options.jobId ?? 'TEST#0:testjob000000000000000000';
	const controller = new AbortController();
	if (options.aborted) controller.abort();
	// 本番と同じく溜めるだけ, 実際の投入はDO側で起きる(ADR-0031)
	const spawns: SpawnRequest[] = [];
	// 本番はDOへ送信するが, ここでは実行の記録だけを残す
	const heartbeats: (number | undefined)[] = [];

	return {
		jobId,
		attempt: options.attempt ?? 1,
		// 実装と同じくジョブIDをそのまま使う, 再試行を跨いで同値になる
		idempotencyKey: options.idempotencyKey ?? jobId,
		signal: controller.signal,
		abort: (reason) => controller.abort(reason),
		spawns,
		heartbeats,
		heartbeat: async (progress) => {
			heartbeats.push(progress);
		},
		spawn: (id, binding, payload, options) => {
			spawns.push({ id, binding, payload, ...(options ? { options } : {}) });
		},
	};
}

export type PerformResult<Result> = { ok: true; value: Result } | { ok: false; error: unknown };

/**
 * performを呼び, 例外を投げずに結果として返す
 * 本番では例外がそのままリトライの判断になるため, 投げたか否かを同じ形で扱えるようにする
 */
export async function runPerformer<Payload, Result, Req extends Requirements, Env>(
	performer: Performer<Payload, Result, Req, Env>,
	payload: Payload,
	ctx: JobContext = createTestContext(),
): Promise<PerformResult<Result>> {
	try {
		return { ok: true, value: await performer.perform(payload, ctx) };
	} catch (error) {
		return { ok: false, error };
	}
}
