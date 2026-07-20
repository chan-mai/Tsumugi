import { shardName } from '../core/ids.js';
import { resolveShard } from '../core/shard.js';
import type { Policy } from '../core/types.js';
import type { EnqueueInput, ShardSettings } from '../do/job-shard.js';

/**
 * DOに投げるRPCの形だけの宣言
 * DOクラス非参照によりenqueue専用WorkerがDO実装を持たずに済む(ADR-0023)
 */
export interface JobShardStub extends Rpc.DurableObjectBranded {
	enqueueMany(inputs: readonly EnqueueInput[], settings?: ShardSettings): Promise<string[]>;
}

/**
 * `DurableObjectNamespace<T>`はTに不変, DO本体の型は`JobShardStub`に代入不可
 * 受け口を緩めて`shardOf`の1箇所で絞る,利用者は自分のEnvをそのまま渡せる
 */
export type ClientEnv = {
	JOB_SHARD: DurableObjectNamespace<any>;
};

export type BindingConfig = {
	/**
	 * 分割数,既定は1
	 * 2以上にするとpartitionKeyが必須になり,キー単位の保証はpartition内に限定される(ADR-0011)
	 */
	shards?: number;
	/** 流量制御3軸とエージング(ADR-0009 / ADR-0020) */
	policy?: Partial<Policy>;
	/**
	 * 終端に達したジョブをDOに残す時間,既定5分
	 * 明細はD1へ投影済みなのでDOに残す理由がなく,溜めるとtickのクエリが重くなる
	 */
	sweepAfterMs?: number;
};

export type TsumugiClient<Env extends ClientEnv> = {
	enqueue(env: Env, input: EnqueueInput): Promise<string>;
	enqueueMany(env: Env, inputs: readonly EnqueueInput[]): Promise<string[]>;
	shardFor(env: Env, binding: string, partitionKey?: string): DurableObjectStub<JobShardStub>;
};

function settingsOf(config: BindingConfig | undefined): ShardSettings | undefined {
	if (!config?.policy && config?.sweepAfterMs === undefined) return undefined;
	return {
		...(config.policy ? { policy: config.policy } : {}),
		...(config.sweepAfterMs !== undefined ? { sweepAfterMs: config.sweepAfterMs } : {}),
	};
}

/**
 * 投入専用の口
 * ジョブ管理Worker本体と別Workerからのenqueueで同一経路
 */
export function createClient<Env extends ClientEnv>(bindings: Record<string, BindingConfig> = {}): TsumugiClient<Env> {
	const shardOf = (env: Env, binding: string, partitionKey: string | undefined) => {
		const config = bindings[binding];
		const shard = resolveShard(binding, config?.shards ?? 1, partitionKey);
		const ns = env.JOB_SHARD as DurableObjectNamespace<JobShardStub>;
		return {
			stub: ns.get(ns.idFromName(shardName(binding, shard))),
			settings: settingsOf(config),
		};
	};

	async function enqueueMany(env: Env, inputs: readonly EnqueueInput[]): Promise<string[]> {
		// 宛先DOごとの集約,逐次の個別RPCはDOの1,000 req/sソフト上限に律速される
		type Group = { stub: DurableObjectStub<JobShardStub>; settings: ShardSettings | undefined; items: EnqueueInput[] };
		const groups = new Map<string, Group>();
		const order: string[] = [];

		for (const input of inputs) {
			const { stub, settings } = shardOf(env, input.binding, input.partitionKey);
			const key = stub.id.toString();
			const group = groups.get(key) ?? { stub, settings, items: [] };
			group.items.push(input);
			groups.set(key, group);
			order.push(key);
		}

		const results = new Map<string, string[]>();
		await Promise.all(
			[...groups.entries()].map(async ([key, group]) => {
				results.set(key, await group.stub.enqueueMany(group.items, group.settings));
			}),
		);

		// 入力の並び順に戻す
		const cursor = new Map<string, number>();
		return order.map((key) => {
			const at = cursor.get(key) ?? 0;
			cursor.set(key, at + 1);
			return results.get(key)?.[at] as string;
		});
	}

	return {
		enqueueMany,
		async enqueue(env, input) {
			const [id] = await enqueueMany(env, [input]);
			return id as string;
		},
		shardFor(env, binding, partitionKey) {
			return shardOf(env, binding, partitionKey).stub;
		},
	};
}
