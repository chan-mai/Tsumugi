import { shardName } from './core/ids.js';
import { createClient, type BindingConfig, type ClientEnv } from './client/enqueue.js';
import type { DispatchMessage, EnqueueInput, TsumugiJobShard } from './do/job-shard.js';
import { handleBatch, type ConsumerEnv, type PerformerRegistry } from './queue/consumer.js';
import type { AuthMiddleware } from './api/auth.js';
import { createRest, type RestEnv } from './api/rest.js';
import { sweepReadModel, type SweepOptions } from './projection/sweep.js';
import type { Ui } from './ui/serve.js';

export type { BindingConfig, ClientEnv };

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
	return createClient<Env>().enqueue(env, input);
}

export async function enqueueMany<Env extends ConsumerEnv>(env: Env, inputs: readonly EnqueueInput[]): Promise<string[]> {
	return createClient<Env>().enqueueMany(env, inputs);
}

export function defineTsumugi<Env extends ConsumerEnv>(config: TsumugiConfig<Env>): Tsumugi<Env> {
	const client = createClient<Env>(config.bindings ?? {});

	const rest = config.auth
		? createRest<Env & RestEnv>(config.auth, {
				...(config.ui ? { dashboard: config.ui } : {}),
				bindings: Object.keys(config.performers),
				enqueue: (env, input) => client.enqueue(env as unknown as Env, input),
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
			return client.shardFor(env, binding, partitionKey) as DurableObjectStub<TsumugiJobShard>;
		},
		enqueue(env, input) {
			return client.enqueue(env, input);
		},
		enqueueMany(env, inputs) {
			return client.enqueueMany(env, inputs);
		},
	};
}
