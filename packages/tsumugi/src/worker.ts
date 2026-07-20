import { shardName } from './core/ids.js';
import { resolveShard } from './core/shard.js';
import type { Policy } from './core/types.js';
import type { DispatchMessage, EnqueueInput, ShardSettings, TsumugiJobShard } from './do/job-shard.js';
import { handleBatch, type ConsumerEnv, type PerformerRegistry } from './queue/consumer.js';
import type { AuthMiddleware } from './api/auth.js';
import { createRest, type RestEnv } from './api/rest.js';
import { sweepReadModel, type SweepOptions } from './projection/sweep.js';
import type { Ui } from './ui/serve.js';

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
	/**
	 * 管理ダッシュボード, `tsumugi/ui`の`ui()`を渡す
	 * 別サブパスにしているので使わなければバンドルに載らない(ADR-0025)
	 */
	ui?: Ui;
	/**
	 * D1の読み取りモデルの保持設定
	 * cronトリガーを設定すると`scheduled`で古い終端ジョブを落とす
	 */
	retention?: SweepOptions;
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
		const settings: ShardSettings | undefined =
			config?.policy || config?.sweepAfterMs !== undefined
				? {
						...(config.policy ? { policy: config.policy } : {}),
						...(config.sweepAfterMs !== undefined ? { sweepAfterMs: config.sweepAfterMs } : {}),
					}
				: undefined;
		return { stub: shardFor(env, binding, shard), settings };
	};

	return {
		shardOf,
		async enqueueMany(env: Env, inputs: readonly EnqueueInput[]): Promise<string[]> {
			// 宛先DOごとにまとめる,個別RPCの逐次投入はDOの1,000 req/sソフト上限に律速される
			type Group = { stub: DurableObjectStub<TsumugiJobShard>; settings: ShardSettings | undefined; items: EnqueueInput[] };
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
		},
	};
}

export function defineTsumugi<Env extends ConsumerEnv>(config: TsumugiConfig<Env>): Tsumugi<Env> {
	const bindings = config.bindings ?? {};
	const router = createRouter<Env>(bindings);

	const rest = config.auth
		? createRest<Env & RestEnv>(config.auth, {
				...(config.ui ? { dashboard: config.ui } : {}),
				bindings: Object.keys(config.performers),
				enqueue: (env, input) => router.enqueueMany(env as unknown as Env, [input]).then(([id]) => id as string),
			})
		: null;

	return {
		async fetch(request, env, ctx): Promise<Response> {
			// 認証が設定されるまで何も生えない,設定漏れが「動かない」として現れる(ADR-0013)
			if (!rest) return new Response('not found', { status: 404 });
			return rest.fetch(request, env as Env & RestEnv, ctx);
		},
		async queue(batch, env): Promise<void> {
			await handleBatch(batch as MessageBatch<DispatchMessage>, env, config.performers);
		},
		async scheduled(_controller, env): Promise<void> {
			// DO側の掃除はtickが行う,ここはD1の読み取りモデルだけ
			const removed = await sweepReadModel((env as Env & RestEnv).TSUMUGI_DB, Date.now(), config.retention ?? {});
			if (removed > 0) console.log(`tsumugi: swept ${removed} jobs from the read model`);
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
