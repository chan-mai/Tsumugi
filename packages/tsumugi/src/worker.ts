import { shardName } from './core/ids.js';
import { createClient, type BindingConfig, type ClientEnv } from './client/enqueue.js';
import { DEFAULT_FAILED_RETENTION_MS } from './do/job-shard.js';
import type { DispatchMessage, EnqueueInput, TsumugiJobShard } from './do/job-shard.js';
import { handleBatch, type ConsumerEnv, type PerformerRegistry } from './queue/consumer.js';
import type { EnvOf, JobQueue, Performers, PerformersOf, TypedEnqueueInput } from './core/api.js';
import type { AuthMiddleware } from './api/auth.js';
import { createRest, type RestEnv } from './api/rest.js';
import { sweepReadModel, type SweepOptions } from './projection/sweep.js';
import type { Ui } from './ui/serve.js';

export type { BindingConfig, ClientEnv };

export type TsumugiConfig<Env extends ConsumerEnv> = {
	/**
	 * binding名とperformerの対応
	 * ここ1箇所に書けばwranglerのservice bindingも型引数の手書きも要らない
	 * この登録簿からenqueueのpayloadと必須キーの型が決まる(ADR-0010)
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

/**
 * `defineTsumugi`の戻り値(ADR-0010)
 * enqueueは`config.performers`から推論した`M`で型付けし, 必須キーの渡し忘れをコンパイルエラーにする
 */
export type Tsumugi<Env, M extends Performers = Performers> = ExportedHandler<Env> & {
	/** envを束ねた型付きの投入口, `JobQueue<M>`を満たす */
	jobs(env: Env): JobQueue<M>;
	/** オブジェクト形の型付きenqueue, bindingでpayloadと必須キーが決まる */
	enqueue(env: Env, input: TypedEnqueueInput<M>): Promise<string>;
	enqueueMany(env: Env, inputs: readonly TypedEnqueueInput<M>[]): Promise<string[]>;
	shardFor(env: Env, binding: keyof M & string, partitionKey?: string): DurableObjectStub<TsumugiJobShard>;
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

/**
 * `M`と`Env`は`config.performers`から推論する(ADR-0010)
 * 明示の型引数は要らず, 登録簿1箇所からenqueueのpayloadと必須キーの型が決まる
 */
export function defineTsumugi<const R extends PerformerRegistry<any>>(
	config: { performers: R } & Omit<TsumugiConfig<any>, 'performers'>,
): Tsumugi<EnvOf<R>, PerformersOf<R>> {
	type Env = ConsumerEnv & RestEnv;
	const client = createClient<Env>(config.bindings ?? {});
	// 公開の型はperformersから推論する, 実行時はEnvを問わないので内部でだけ緩める
	const performers = config.performers as unknown as PerformerRegistry<Env>;

	const rest = config.auth
		? createRest<Env>(config.auth, {
				...(config.ui ? { dashboard: config.ui } : {}),
				bindings: Object.keys(performers),
				enqueue: (env, input) => client.enqueue(env, input),
				// 一覧のretryable判定に使う, UI側が押す前に可否を出せるようにする(ADR-0027)
				failedRetentionMs: (binding) => config.bindings?.[binding]?.failedRetentionMs ?? DEFAULT_FAILED_RETENTION_MS,
			})
		: null;

	const handler = {
		async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
			// 認証が設定されるまで何も生えない,設定漏れが「動かない」として現れる(ADR-0013)
			if (!rest) return new Response('not found', { status: 404 });
			return rest.fetch(request, env, ctx);
		},
		async queue(batch: MessageBatch<DispatchMessage>, env: Env): Promise<void> {
			await handleBatch(batch, env, performers);
		},
		async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
			// DO側の掃除はtickが行う,ここはD1の読み取りモデルだけ
			const removed = await sweepReadModel(env.TSUMUGI_DB, Date.now(), config.retention ?? {});
			if (removed > 0) console.log(`tsumugi: swept ${removed} jobs from the read model`);
		},
		jobs(env: Env): JobQueue<PerformersOf<R>> {
			return {
				// positional形をDOが受けるEnqueueInputへ寄せる, 型はJobQueue<M>で縛る
				enqueue: (binding: string, payload: unknown, options?: object) =>
					client.enqueue(env, { binding, payload, ...options } as EnqueueInput),
				enqueueMany: (items: readonly { binding: string; payload: unknown; options?: object }[]) =>
					client.enqueueMany(
						env,
						items.map((it) => ({ binding: it.binding, payload: it.payload, ...it.options }) as EnqueueInput),
					),
			} as JobQueue<PerformersOf<R>>;
		},
		shardFor(env: Env, binding: string, partitionKey?: string): DurableObjectStub<TsumugiJobShard> {
			return client.shardFor(env, binding, partitionKey) as DurableObjectStub<TsumugiJobShard>;
		},
		enqueue(env: Env, input: TypedEnqueueInput<PerformersOf<R>>): Promise<string> {
			// TypedEnqueueInputは構造的にEnqueueInputの部分集合なのでそのまま渡せる
			return client.enqueue(env, input as unknown as EnqueueInput);
		},
		enqueueMany(env: Env, inputs: readonly TypedEnqueueInput<PerformersOf<R>>[]): Promise<string[]> {
			return client.enqueueMany(env, inputs as unknown as readonly EnqueueInput[]);
		},
	};

	return handler as unknown as Tsumugi<EnvOf<R>, PerformersOf<R>>;
}
