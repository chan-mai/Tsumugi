import { shardName } from './core/ids.js';
import type { DispatchMessage, EnqueueInput, TsumugiJobShard } from './do/job-shard.js';
import { handleBatch, type ConsumerEnv, type PerformerRegistry } from './queue/consumer.js';

export type TsumugiConfig<Env extends ConsumerEnv> = {
	/**
	 * binding名とperformerの対応
	 * ここ1箇所に書けばwranglerのservice bindingも型引数の手書きも要らない
	 */
	performers: PerformerRegistry<Env>;
};

/** binding名から担当DOのstubを引く,既定のshard数は1なので常に0番(ADR-0011) */
export function shardFor<Env extends ConsumerEnv>(env: Env, binding: string, shard = 0): DurableObjectStub<TsumugiJobShard> {
	return env.JOB_SHARD.get(env.JOB_SHARD.idFromName(shardName(binding, shard)));
}

export async function enqueue<Env extends ConsumerEnv>(env: Env, input: EnqueueInput): Promise<string> {
	return shardFor(env, input.binding).enqueue(input);
}

export async function enqueueMany<Env extends ConsumerEnv>(env: Env, inputs: readonly EnqueueInput[]): Promise<string[]> {
	// binding単位でDOが分かれるのでまとめてから投げる
	const byBinding = new Map<string, EnqueueInput[]>();
	for (const input of inputs) {
		const list = byBinding.get(input.binding);
		if (list) list.push(input);
		else byBinding.set(input.binding, [input]);
	}
	const results = await Promise.all([...byBinding.entries()].map(([binding, group]) => shardFor(env, binding).enqueueMany(group)));
	return results.flat();
}

export function defineTsumugi<Env extends ConsumerEnv>(config: TsumugiConfig<Env>): ExportedHandler<Env> {
	return {
		async fetch(): Promise<Response> {
			// M4でREST APIとダッシュボードに置き換える
			return new Response('tsumugi');
		},
		async queue(batch, env): Promise<void> {
			await handleBatch(batch as MessageBatch<DispatchMessage>, env, config.performers);
		},
	};
}
