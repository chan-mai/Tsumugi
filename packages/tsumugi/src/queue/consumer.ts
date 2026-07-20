import type { Performer } from '../core/api.js';
import { shardNameOf } from '../core/ids.js';
import type { DispatchMessage, TsumugiJobShard } from '../do/job-shard.js';

export type PerformerCtor<Env> = new (env: Env) => Performer<any, any, any, Env>;

/** binding名からperformerを引くための登録簿,コード側で宣言し型推論の源にもなる */
export type PerformerRegistry<Env> = Record<string, PerformerCtor<Env>>;

export type ConsumerEnv = {
	JOB_SHARD: DurableObjectNamespace<TsumugiJobShard>;
};

export class TsumugiTimeoutError extends Error {
	constructor(
		readonly jobId: string,
		readonly timeoutMs: number,
	) {
		super(`ジョブがタイムアウトした(${jobId}, ${timeoutMs}ms)`);
		this.name = 'TsumugiTimeoutError';
	}
}

export function shardStub<Env extends ConsumerEnv>(env: Env, jobId: string): DurableObjectStub<TsumugiJobShard> {
	return env.JOB_SHARD.get(env.JOB_SHARD.idFromName(shardNameOf(jobId)));
}

/**
 * timeoutで待つのをやめる
 *
 * performerの実行自体は止められない,ランタイムの制約で回避不能
 * `signal`は協調的な中断の依頼,応じないperformerは走り続ける
 */
function withTimeout<T>(jobId: string, timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	if (timeoutMs <= 0) return run(controller.signal);

	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			controller.abort();
			reject(new TsumugiTimeoutError(jobId, timeoutMs));
		}, timeoutMs);
		run(controller.signal).then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/**
 * Queuesのconsumer
 *
 * 成否によらず必ずackする(ADR-0004)
 * Queuesのretryに乗せないことで`max_retries`と`delaySeconds`の上限が製品仕様に漏れなくなり,
 * リトライ回数もバックオフも全てDOのalarmが持てるようになる
 */
export async function handleBatch<Env extends ConsumerEnv>(
	batch: MessageBatch<DispatchMessage>,
	env: Env,
	performers: PerformerRegistry<Env>,
): Promise<void> {
	await Promise.allSettled(batch.messages.map((message) => handleOne(message, env, performers)));
}

async function handleOne<Env extends ConsumerEnv>(
	message: Message<DispatchMessage>,
	env: Env,
	performers: PerformerRegistry<Env>,
): Promise<void> {
	const { jobId, binding, attempt, payload, timeoutMs, claimRequired } = message.body;
	let ok = false;

	try {
		if (claimRequired && !(await shardStub(env, jobId).claim(jobId))) {
			// 重複配送で他方が既に実行権を取っている,二重実行を避けるため何もせず降りる(ADR-0007)
			message.ack();
			return;
		}

		const ctor = performers[binding];
		if (!ctor) throw new Error(`performerが未登録: ${binding}`);

		await withTimeout(jobId, timeoutMs, (signal) =>
			Promise.resolve(new ctor(env).perform(payload, { jobId, attempt, idempotencyKey: jobId, signal })),
		);
		ok = true;
	} catch (error) {
		console.error(`tsumugi: perform failed (${jobId})`, error);
	}

	message.ack();

	try {
		await shardStub(env, jobId).report(jobId, { ok });
	} catch (error) {
		// 報告が失われるとジョブはQUEUEDのまま残る, reaperが沈黙として回収する
		console.error(`tsumugi: report failed (${jobId})`, error);
	}
}
