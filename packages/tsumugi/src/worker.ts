import { createId } from '@paralleldrive/cuid2';
import { assertValidFlow, formatRunId, shardName } from './core/ids.js';
import { createClient, type BindingConfig, type ClientEnv } from './client/enqueue.js';
import { DEFAULT_FAILED_RETENTION_MS } from './do/job-shard.js';
import type { DispatchMessage, EnqueueInput, MutationResult, TsumugiJobShard } from './do/job-shard.js';
import { createRunClass, type RunClass, type RunSettings, type StartResult } from './do/run.js';
import { handleBatch, type ConsumerEnv, type PerformerRegistry } from './queue/consumer.js';
import type { EnvOf, JobQueue, Performers, PerformersOf, TypedEnqueueInput } from './core/api.js';
import type { Flows, InputOf } from './core/flow.js';
import type { AuthMiddleware } from './api/auth.js';
import { createRest, type RestEnv } from './api/rest.js';
import { sweepReadModel, type SweepOptions } from './projection/sweep.js';
import type { Ui } from './ui/serve.js';

export type { BindingConfig, ClientEnv };

/**
 * Run DOを参照するためのbinding(ADR-0029)
 * flowsを使う場合のみ必要なので任意, 未設定の場合は開始時にエラーにする(ADR-0013)
 */
export type RunNamespaceEnv = {
	RUN?: DurableObjectNamespace<RunControl>;
};

/** worker側から見たRun DO */
export interface RunControl extends Rpc.DurableObjectBranded {
	start(input: { flow: string; input: unknown }): Promise<StartResult>;
	cancel(): Promise<MutationResult>;
	retry(): Promise<MutationResult>;
}

export type TsumugiConfig<Env extends ConsumerEnv> = {
	/**
	 * binding名とperformerの対応
	 * ここ1箇所に書けばwranglerのservice bindingも型引数の手書きも要らない
	 * `performers`からenqueueのpayloadと必須キーの型が決まる(ADR-0010)
	 */
	performers: PerformerRegistry<Env>;
	/**
	 * flow名とグラフ定義の対応(ADR-0030)
	 * 指定した場合のみRun DOのエクスポートとbindingが必要, 未指定なら設定の変更は不要
	 */
	flows?: Flows;
	/** runの規模と保持の設定(ADR-0034 / ADR-0035) */
	runs?: RunSettings;
	bindings?: Record<string, BindingConfig>;
	/**
	 * 認証ミドルウェア, 未設定ならREST APIもダッシュボードも無効(ADR-0013)
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
export type Tsumugi<Env, M extends Performers = Performers, F extends Flows = Flows> = ExportedHandler<Env> & {
	/** envを束ねた型付きの投入口, `JobQueue<M>`を満たす */
	jobs(env: Env): JobQueue<M>;
	/** オブジェクト形の型付きenqueue, bindingでpayloadと必須キーが決まる */
	enqueue(env: Env, input: TypedEnqueueInput<M>): Promise<string>;
	enqueueMany(env: Env, inputs: readonly TypedEnqueueInput<M>[]): Promise<string[]>;
	shardFor(env: Env, binding: keyof M & string, partitionKey?: string): DurableObjectStub<TsumugiJobShard>;
	/**
	 * runを開始してrunIdを返す(ADR-0029)
	 * `id`を渡すと同じrunIdになり,二度目の開始は既存を返すので再送で増えない
	 */
	start<K extends keyof F & string>(env: Env, flow: K, input: InputOf<F[K]>, options?: { id?: string }): Promise<string>;
	runFor(env: Env, runId: string): DurableObjectStub<RunControl>;
	/**
	 * Run DOのクラス, wranglerのclass_nameはエクスポートした名前を指す(ADR-0030)
	 * flow定義を参照するのでパッケージから直接エクスポートできない
	 */
	runClass: RunClass;
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
 * 明示の型引数は不要で, `performers`1箇所からenqueueのpayloadと必須キーの型が決まる
 */
export function defineTsumugi<const R extends PerformerRegistry<any>, const F extends Flows = {}>(
	config: { performers: R; flows?: F } & Omit<TsumugiConfig<any>, 'performers' | 'flows'>,
): Tsumugi<EnvOf<R>, PerformersOf<R>, F> {
	type Env = ConsumerEnv & RestEnv & RunNamespaceEnv;
	const client = createClient<Env>(config.bindings ?? {});
	// 公開の型はperformersから推論する, 実行時はEnvを問わないので内部でだけ緩める
	const performers = config.performers as unknown as PerformerRegistry<Env>;
	const flows: Flows = config.flows ?? {};
	// flow名はrunIdの一部になる, 起動時に弾かないと開始まで誤りに気付けない(ADR-0029)
	for (const flow of Object.keys(flows)) assertValidFlow(flow);
	// subflowの起動先が`flows`に無いと子のrunIdを決められない, 同じく起動時に弾く
	const registered = new Set(Object.values(flows));
	for (const [name, flow] of Object.entries(flows)) {
		for (const node of flow.nodes) {
			if (node.subflow && !registered.has(node.subflow)) throw new Error(`subflow target is not registered: ${name}.${node.id}`);
		}
	}

	/** 設定漏れは開始時にエラーにする, エラーにしないとノードが永久に実行されない(ADR-0013) */
	const runFor = (env: Env, runId: string): DurableObjectStub<RunControl> => {
		const namespace = env.RUN;
		if (!namespace) throw new Error('RUN binding is not configured, add the Run DO binding to wrangler');
		return namespace.get(namespace.idFromName(runId));
	};

	const start = async (env: Env, flow: string, input: unknown, options?: { id?: string }): Promise<string> => {
		if (!flows[flow]) throw new Error(`flow is not registered: ${flow}`);
		const runId = formatRunId({ flow, localId: options?.id ?? createId() });
		const result = await runFor(env, runId).start({ flow, input });
		return result.id;
	};

	const rest = config.auth
		? createRest<Env>(config.auth, {
				...(config.ui ? { dashboard: config.ui } : {}),
				bindings: Object.keys(performers),
				enqueue: (env, input) => client.enqueue(env, input),
				// 一覧のretryable判定に使う, UI側が押す前に可否を出せるようにする(ADR-0027)
				failedRetentionMs: (binding) => config.bindings?.[binding]?.failedRetentionMs ?? DEFAULT_FAILED_RETENTION_MS,
				flows: Object.keys(flows),
				// flowが1つも無い構成では渡さない, 渡すとRESTが501の代わりに500で落ちる
				...(Object.keys(flows).length > 0
					? {
							start: (env: Env, flow: string, input: unknown, id?: string) => start(env, flow, input, id === undefined ? {} : { id }),
							runFor,
						}
					: {}),
			})
		: null;

	const handler = {
		async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
			// 認証が設定されるまで何も提供しない, 設定漏れが動作しない状態として現れる(ADR-0013)
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
				// positional形をDOが受けるEnqueueInputへ変換する, 型はJobQueue<M>で縛る
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
		start,
		runFor,
		// flow定義を参照するクラスをここで作る, パッケージから直接エクスポートできない理由(ADR-0030)
		runClass: createRunClass({ flows, bindings: config.bindings ?? {}, ...(config.runs ? { settings: config.runs } : {}) }),
	};

	return handler as unknown as Tsumugi<EnvOf<R>, PerformersOf<R>, F>;
}
