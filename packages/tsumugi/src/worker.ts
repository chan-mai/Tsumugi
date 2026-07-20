import { shardName } from './core/ids.js';
import { resolveShard } from './core/shard.js';
import type { Policy } from './core/types.js';
import type { DispatchMessage, EnqueueInput, TsumugiJobShard } from './do/job-shard.js';
import { handleBatch, type ConsumerEnv, type PerformerRegistry } from './queue/consumer.js';
import type { AuthMiddleware } from './api/auth.js';
import { createRest, type RestEnv } from './api/rest.js';

export type BindingConfig = {
	/**
	 * 分割数,既定は1
	 * 2以上にするとpartitionKeyが必須になり,キー単位の保証はpartition内に限定される(ADR-0011)
	 */
	shards?: number;
	/** 流量制御3軸とエージング(ADR-0009 / ADR-0020) */
	policy?: Partial<Policy>;
};

export type TsumugiConfig<Env extends ConsumerEnv> = {
	/**
	 * binding名とperformerの対応
	 * ここ1箇所に書けばwranglerのservice bindingも型引数の手書きも要らない
	 */
	performers: PerformerRegistry<Env>;
	bindings?: Record<string, BindingConfig>;
	/**
	 * 認証ミドルウェア,未設定ならREST APIもダッシュボードも生えない(ADR-0013)
	 * 同梱の`bearerAuth`でも任意のHonoミドルウェアでもよい
	 */
	auth?: AuthMiddleware;
};

export type Tsumugi<Env extends ConsumerEnv> = ExportedHandler<Env> & {
	enqueue(env: Env, input: EnqueueInput): Promise<string>;
	enqueueMany(env: Env, inputs: readonly EnqueueInput[]): Promise<string[]>;
	shardFor(env: Env, binding: string, partitionKey?: string): DurableObjectStub<TsumugiJobShard>;
};

/** 分割していない既定構成向け, shards=1なので常に0番(ADR-0011) */
export function shardFor<Env extends ConsumerEnv>(env: Env, binding: string, shard = 0): DurableObjectStub<TsumugiJobShard> {
	return env.JOB_SHARD.get(env.JOB_SHARD.idFromName(shardName(binding, shard)));
}

export async function enqueue<Env extends ConsumerEnv>(env: Env, input: EnqueueInput): Promise<string> {
	return shardFor(env, input.binding).enqueue(input);
}

export async function enqueueMany<Env extends ConsumerEnv>(env: Env, inputs: readonly EnqueueInput[]): Promise<string[]> {
	return createRouter<Env>({}).enqueueMany(env, inputs);
}

function createRouter<Env extends ConsumerEnv>(bindings: Record<string, BindingConfig>) {
	const shardOf = (env: Env, binding: string, partitionKey: string | undefined) => {
		const config = bindings[binding];
		const shard = resolveShard(binding, config?.shards ?? 1, partitionKey);
		return { stub: shardFor(env, binding, shard), policy: config?.policy };
	};

	return {
		shardOf,
		async enqueueMany(env: Env, inputs: readonly EnqueueInput[]): Promise<string[]> {
			// 宛先DOごとにまとめる,個別RPCの逐次投入はDOの1,000 req/sソフト上限に律速される
			type Group = { stub: DurableObjectStub<TsumugiJobShard>; policy: Partial<Policy> | undefined; items: EnqueueInput[] };
			const groups = new Map<string, Group>();
			const order: string[] = [];

			for (const input of inputs) {
				const { stub, policy } = shardOf(env, input.binding, input.partitionKey);
				const key = stub.id.toString();
				const group = groups.get(key) ?? { stub, policy, items: [] };
				group.items.push(input);
				groups.set(key, group);
				order.push(key);
			}

			const results = new Map<string, string[]>();
			await Promise.all(
				[...groups.entries()].map(async ([key, group]) => {
					results.set(key, await group.stub.enqueueMany(group.items, group.policy));
				}),
			);

			// 入力の並び順に戻す
			const cursor = new Map<string, number>();
			return order.map((key) => {
				const at = cursor.get(key) ?? 0;
				cursor.set(key, at + 1);
				return results.get(key)?.[at] as string;
			});
		},
	};
}

export function defineTsumugi<Env extends ConsumerEnv>(config: TsumugiConfig<Env>): Tsumugi<Env> {
	const bindings = config.bindings ?? {};
	const router = createRouter<Env>(bindings);

	const rest = config.auth ? createRest<Env & RestEnv>(config.auth) : null;

	return {
		async fetch(request, env, ctx): Promise<Response> {
			// 認証が設定されるまで何も生えない,設定漏れが「動かない」として現れる(ADR-0013)
			if (!rest) return new Response('not found', { status: 404 });
			return rest.fetch(request, env as Env & RestEnv, ctx);
		},
		async queue(batch, env): Promise<void> {
			await handleBatch(batch as MessageBatch<DispatchMessage>, env, config.performers);
		},
		shardFor(env, binding, partitionKey) {
			return router.shardOf(env, binding, partitionKey).stub;
		},
		async enqueue(env, input) {
			const [id] = await router.enqueueMany(env, [input]);
			return id as string;
		},
		enqueueMany(env, inputs) {
			return router.enqueueMany(env, inputs);
		},
	};
}
