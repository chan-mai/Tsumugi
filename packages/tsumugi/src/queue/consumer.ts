import type { Performer } from '../core/api.js';
import { shardNameOf } from '../core/ids.js';
import type { DispatchMessage, TsumugiJobShard } from '../do/job-shard.js';

export type PerformerCtor<Env> = new (env: Env) => Performer<any, any, any, Env>;

/** binding名からperformerを引くための登録簿,コード側で宣言し型推論の源にもなる */
export type PerformerRegistry<Env> = Record<string, PerformerCtor<Env>>;

export type ConsumerEnv = {
	JOB_SHARD: DurableObjectNamespace<TsumugiJobShard>;
};

export function shardStub<Env extends ConsumerEnv>(env: Env, jobId: string): DurableObjectStub<TsumugiJobShard> {
	return env.JOB_SHARD.get(env.JOB_SHARD.idFromName(shardNameOf(jobId)));
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
	const { jobId, binding, attempt, payload } = message.body;
	let ok = false;

	try {
		const ctor = performers[binding];
		if (!ctor) throw new Error(`performerが未登録: ${binding}`);
		// M2でtimeoutMsに連動させる,現時点では常に非abort
		const controller = new AbortController();
		await new ctor(env).perform(payload, {
			jobId,
			attempt,
			idempotencyKey: jobId,
			signal: controller.signal,
		});
		ok = true;
	} catch (error) {
		console.error(`tsumugi: perform failed (${jobId})`, error);
	}

	message.ack();

	try {
		await shardStub(env, jobId).report(jobId, { ok });
	} catch (error) {
		// 報告が失われるとジョブはQUEUEDのまま残る, M2のreaperが回収する
		console.error(`tsumugi: report failed (${jobId})`, error);
	}
}
