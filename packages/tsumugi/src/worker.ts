import { createId } from '@paralleldrive/cuid2';
import { assertValidFlow, formatRunId, shardName } from './core/ids.js';
import { configOf, createClient, type BindingConfig, type ClientEnv } from './client/enqueue.js';
import { DEFAULT_FAILED_RETENTION_MS } from './do/job-shard.js';
import type { DispatchMessage, EnqueueInput, MutationResult, TsumugiJobShard } from './do/job-shard.js';
import { createRunClass, type RunClass, type RunSettings, type StartResult } from './do/run.js';
import { createSchedulerClass, SCHEDULER_DO_NAME, type SchedulerClass, type ScheduleView } from './do/scheduler.js';
import type { AnySchedules, ScheduleDefs } from './core/recurring.js';
import { handleBatch, type ConsumerEnv, type PerformerRegistry, type PerformerSource } from './queue/consumer.js';
import type { EnvOf, FailurePerformer, JobQueue, Performers, PerformersOf, TypedEnqueueInput } from './core/api.js';
import type { Flows, InputOf } from './core/flow.js';
import type { AuthMiddleware } from './api/auth.js';
import { createRest, type RestEnv } from './api/rest.js';
import { sweepReadModel, type SweepOptions } from './projection/sweep.js';
import type { Ui } from './ui/serve.js';
import type { MetricsResolver } from './analytics/reader.js';
import { cachedValidate } from './config/validate.js';
import { configErrorMessage } from './config/fragment.js';

export type { BindingConfig, ClientEnv };

/**
 * Run DOを参照するためのbinding(ADR-0029)
 * flowsを使う場合のみ必要で任意, 未設定の場合は開始時にエラー(ADR-0013)
 */
export type RunNamespaceEnv = {
	RUN?: DurableObjectNamespace<RunControl>;
};

/** worker側から見たRun DO */
export interface RunControl extends Rpc.DurableObjectBranded {
	start(input: { flow: string; input: unknown; deadlineMs?: number }): Promise<StartResult>;
	cancel(): Promise<MutationResult>;
	retry(): Promise<MutationResult>;
}

/** runの開始オプション, deadlineMsはflow定義の期限より優先(ADR-0039) */
export type StartOptions = { id?: string; deadlineMs?: number };

/**
 * Scheduler DOを参照するためのbinding(ADR-0040)
 * schedulesを使う場合のみ必要で任意, 未設定の場合は起動時検証が報告(ADR-0013)
 */
export type SchedulerNamespaceEnv = {
	SCHEDULER?: DurableObjectNamespace<SchedulerControl>;
};

/** worker側から見たScheduler DO */
export interface SchedulerControl extends Rpc.DurableObjectBranded {
	sync(): Promise<void>;
	list(): Promise<ScheduleView[]>;
}

export type TsumugiConfig<Env extends ConsumerEnv> = {
	/**
	 * binding名とperformerの対応
	 * performerのモジュールをそのまま渡す, 実行時の解決は`ctx.exports`が担当(ADR-0037)
	 * ここからenqueueのpayloadと必須キーの型が確定(ADR-0010)
	 */
	performers: PerformerRegistry<Env>;
	/**
	 * flow名とグラフ定義の対応(ADR-0030)
	 * 指定した場合のみRun DOのエクスポートとbindingが必要, 未指定なら設定の変更は不要
	 */
	flows?: Flows;
	/**
	 * 失敗したジョブを知らせる先のbinding(#30)
	 * FAILEDとSTALLEDに達したジョブが`FailureNotice`をpayloadとして届く
	 * 通知そのものの失敗は通知の対象外, 自分を呼び続ける循環の防止
	 */
	onFailure?: string;
	/**
	 * 定期実行の定義(ADR-0040)
	 * 指定した場合のみScheduler DOのエクスポートとbindingが必要
	 * binding名とpayloadの型は`defineTsumugi`のインライン型が`performers`から強制
	 */
	schedules?: ScheduleDefs<any, any>;
	/** runの規模と保持の設定(ADR-0034 / ADR-0035) */
	runs?: RunSettings;
	bindings?: Record<string, BindingConfig>;
	/**
	 * 認証ミドルウェア, 未設定ならREST APIもダッシュボードも無効(ADR-0013)
	 * 同梱の`bearerAuth`でも任意のHonoミドルウェアでもよい
	 * 認証なしで開放する場合は`unsafeNoAuth`を明示的に渡す(ADR-0044)
	 */
	auth?: AuthMiddleware;
	/**
	 * 管理ダッシュボード, `tsumugi/ui`の`ui()`を渡す
	 * 別サブパスにより未使用ならバンドルに含まれない(ADR-0025)
	 */
	ui?: Ui;
	/**
	 * D1の読み取りモデルの保持設定
	 * cronトリガーを設定すると`scheduled`で古い終端ジョブを削除
	 */
	retention?: SweepOptions;
	/**
	 * Analytics Engineを読むための設定
	 * アカウントのAPIトークンが必要で、secretと同じく`env`から取得する関数で渡す
	 * 未設定ならメトリクスの画面もAPIも無効
	 */
	metrics?: MetricsResolver<Env>;
};

/**
 * `defineTsumugi`の戻り値(ADR-0010)
 * enqueueは`config.performers`から推論した`M`で型付けし、必須キーの渡し忘れはコンパイルエラー
 */
export type Tsumugi<Env, M extends Performers = Performers, F extends Flows = Flows> = ExportedHandler<Env> & {
	/** envを束ねた型付きの投入口, `JobQueue<M>`を満たす */
	jobs(env: Env): JobQueue<M>;
	/** オブジェクト形の型付きenqueue, bindingでpayloadと必須キーが確定 */
	enqueue(env: Env, input: TypedEnqueueInput<M>): Promise<string>;
	enqueueMany(env: Env, inputs: readonly TypedEnqueueInput<M>[]): Promise<string[]>;
	shardFor(env: Env, binding: keyof M & string, partitionKey?: string): DurableObjectStub<TsumugiJobShard>;
	/**
	 * runを開始してrunIdを返す(ADR-0029)
	 * `id`を渡すと同じrunIdになり、二度目の開始は既存を返し再送で増えない
	 * `deadlineMs`を渡すとflow定義の期限より優先(ADR-0039)
	 */
	start<K extends keyof F & string>(env: Env, flow: K, input: InputOf<F[K]>, options?: StartOptions): Promise<string>;
	runFor(env: Env, runId: string): DurableObjectStub<RunControl>;
	/**
	 * Run DOのクラス, wranglerのclass_nameはエクスポートした名前を指す(ADR-0030)
	 * flow定義を参照しパッケージから直接エクスポート不可
	 */
	runClass: RunClass;
	/**
	 * Scheduler DOのクラス(ADR-0040)
	 * schedulesの定義を参照し、runClassと同じくパッケージから直接エクスポート不可
	 */
	schedulerClass: SchedulerClass;
};

/** 分割していない既定構成向け, shards=1で常に0番(ADR-0011) */
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
 * 明示の型引数は不要で、`performers`1箇所からenqueueのpayloadと必須キーの型が確定
 */
export function defineTsumugi<const R extends PerformerRegistry<any>, const F extends Flows = {}>(
	// schedulesはR/Fの型を参照しOmit経由は不可, NoInferで推論源から除外
	config: {
		performers: R;
		flows?: F;
		schedules?: ScheduleDefs<NoInfer<PerformersOf<R>>, NoInfer<F>>;
		onFailure?: FailurePerformer<NoInfer<PerformersOf<R>>>;
	} & Omit<TsumugiConfig<any>, 'performers' | 'flows' | 'schedules' | 'onFailure'>,
): Tsumugi<EnvOf<R>, PerformersOf<R>, F> {
	type Env = ConsumerEnv & RestEnv & RunNamespaceEnv & SchedulerNamespaceEnv;
	// 失敗の通知先は投入のたびにDOへ送る, bindingを問わず同じ値(#30)
	// 宛先は常に渡す, onFailure解除後に既存のshardが古い宛先へ送り続けるのを防止(#30)
	const client = createClient<Env>(config.bindings ?? {}, { failureBinding: config.onFailure ?? null });
	// 公開の型はperformersから推論, 実行時はEnvを問わず内部のみ緩い型を使用
	const performers = config.performers as unknown as PerformerRegistry<Env>;
	const flows: Flows = config.flows ?? {};
	const schedules: AnySchedules = (config.schedules ?? {}) as AnySchedules;
	// flow名はrunIdの一部, 起動時に拒否しないと開始まで誤りが発覚しない(ADR-0029)
	for (const flow of Object.keys(flows)) assertValidFlow(flow);
	// subflowの起動先が`flows`に無いと子のrunIdが決定不能, 同じく起動時に拒否
	const registered = new Set(Object.values(flows));
	for (const [name, flow] of Object.entries(flows)) {
		for (const node of flow.nodes) {
			if (node.subflow && !registered.has(node.subflow)) throw new Error(`subflow target is not registered: ${name}.${node.id}`);
		}
	}

	// scheduleの定義の誤りはここでエラー, 発火まで発覚しないと定期実行が警告なく停止(ADR-0040)
	const schedulerClass = createSchedulerClass({
		schedules,
		bindings: config.bindings ?? {},
		targets: { bindings: Object.keys(performers), flows: Object.keys(flows) },
		failureBinding: config.onFailure ?? null,
	});

	// Workersに起動フックが無く、最初の呼び出しを起動とみなして検証(ADR-0036)
	const checkConfig = cachedValidate({ performers, flows, schedules });

	/**
	 * 設定漏れを不足の一覧付きで拒否(ADR-0013)
	 * 貼り付け可能な断片まで含めた本文とし、番号だけでは何を追加すべきか不明
	 */
	const assertConfigured = (env: Env): void => {
		const status = checkConfig(env as unknown as Record<string, unknown>);
		if (!status.ok) throw new Error(configErrorMessage(status.missing));
	};

	/** 設定漏れは開始時にエラー, 放置ではノードが永久に未実行(ADR-0013) */
	const runFor = (env: Env, runId: string): DurableObjectStub<RunControl> => {
		const namespace = env.RUN;
		// RUNだけ個別に判定, 不足の一覧より宛先が無い事実を先に伝える方が短い
		if (!namespace) throw new Error('RUN binding is not configured, add the Run DO binding to wrangler');
		return namespace.get(namespace.idFromName(runId));
	};

	const schedulerFor = (env: Env): DurableObjectStub<SchedulerControl> => {
		const namespace = env.SCHEDULER;
		// SCHEDULERだけ個別に判定, 不足の一覧より宛先が無い事実を先に伝える方が短い
		if (!namespace) throw new Error('SCHEDULER binding is not configured, add the Scheduler DO binding to wrangler');
		return namespace.get(namespace.idFromName(SCHEDULER_DO_NAME));
	};

	/**
	 * Scheduler DOへの同期はisolateごとに1回でよい(ADR-0040)
	 * alarmは一度設定すれば継続し、ここは初回導入とデプロイ直後の契機のみ
	 */
	let primed: Promise<void> | undefined;
	const prime = (env: Env, ctx: ExecutionContext): void => {
		if (Object.keys(schedules).length === 0 || primed !== undefined) return;
		// bindingの不足はcachedValidateが報告, ここでエラーにすると全リクエストが失敗
		if (!env.SCHEDULER) return;
		primed = schedulerFor(env)
			.sync()
			.catch((error) => {
				console.error('tsumugi: scheduler sync failed', error);
				// 失敗は保存せず次のイベントで再試行
				primed = undefined;
			});
		ctx.waitUntil(primed);
	};

	const start = async (env: Env, flow: string, input: unknown, options?: StartOptions): Promise<string> => {
		assertConfigured(env);
		if (!Object.hasOwn(flows, flow)) throw new Error(`flow is not registered: ${flow}`);
		const runId = formatRunId({ flow, localId: options?.id ?? createId() });
		const result = await runFor(env, runId).start({
			flow,
			input,
			...(options?.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}),
		});
		return result.id;
	};

	const rest = config.auth
		? createRest<Env>(config.auth, {
				...(config.ui ? { dashboard: config.ui } : {}),
				bindings: Object.keys(performers),
				// 流量の変更を全shardへ配るために必要(#27)
				shardsOf: (binding) => configOf(config.bindings ?? {}, binding)?.shards ?? 1,
				enqueue: (env, input) => client.enqueue(env, input),
				// 一覧のretryable判定に使う, UI側が押す前に可否を出せるようにする(ADR-0027)
				failedRetentionMs: (binding) => configOf(config.bindings ?? {}, binding)?.failedRetentionMs ?? DEFAULT_FAILED_RETENTION_MS,
				flows: Object.keys(flows),
				// 未設定なら渡さない, `/api/metrics`は501を返す
				...(config.metrics ? { metrics: config.metrics as MetricsResolver<Env> } : {}),
				// flowが1つも無い構成では渡さない, 渡すとRESTが501の代わりに500で落ちる
				...(Object.keys(flows).length > 0 ? { start, runFor } : {}),
				// scheduleが無ければ`/api/schedules`は501を返す
				...(Object.keys(schedules).length > 0 ? { schedulerFor } : {}),
			})
		: null;

	const handler = {
		async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
			prime(env, ctx);
			// 認証が設定されるまで何も提供しない, 設定漏れが動作しない状態として現れる(ADR-0013)
			if (!rest) return new Response('not found', { status: 404 });

			// bindingの不足はマイグレーションの適用漏れと同じく503で拒否, どちらも構成の問題(ADR-0036)
			const status = checkConfig(env as unknown as Record<string, unknown>);
			if (!status.ok && new URL(request.url).pathname.startsWith('/api/')) {
				return Response.json({ error: configErrorMessage(status.missing), missing: status.missing }, { status: 503 });
			}
			return rest.fetch(request, env, ctx);
		},
		async queue(batch: MessageBatch<DispatchMessage>, env: Env, ctx: ExecutionContext): Promise<void> {
			prime(env, ctx);
			// performerは`ctx.exports`から引く, 同一Workerでも別途のbindingは要らない(ADR-0037)
			await handleBatch(batch, env, (ctx as unknown as { exports?: PerformerSource }).exports ?? {});
		},
		async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
			prime(env, ctx);
			// DO側の削除はtickが担当, ここはD1の読み取りモデルだけ
			const removed = await sweepReadModel(env.TSUMUGI_DB, Date.now(), config.retention ?? {});
			if (removed > 0) console.log(`tsumugi: swept ${removed} jobs from the read model`);
		},
		jobs(env: Env): JobQueue<PerformersOf<R>> {
			return {
				// positional形をDOが受けるEnqueueInputへ変換する, 型はJobQueue<M>で縛る
				enqueue: (binding: string, payload: unknown, options?: object) => {
					assertConfigured(env);
					return client.enqueue(env, { binding, payload, ...options } as EnqueueInput);
				},
				enqueueMany: (items: readonly { binding: string; payload: unknown; options?: object }[]) => {
					assertConfigured(env);
					return client.enqueueMany(
						env,
						items.map((it) => ({ binding: it.binding, payload: it.payload, ...it.options }) as EnqueueInput),
					);
				},
			} as JobQueue<PerformersOf<R>>;
		},
		shardFor(env: Env, binding: string, partitionKey?: string): DurableObjectStub<TsumugiJobShard> {
			return client.shardFor(env, binding, partitionKey) as DurableObjectStub<TsumugiJobShard>;
		},
		enqueue(env: Env, input: TypedEnqueueInput<PerformersOf<R>>): Promise<string> {
			assertConfigured(env);
			// TypedEnqueueInputは構造的にEnqueueInputの部分集合なのでそのまま渡せる
			return client.enqueue(env, input as unknown as EnqueueInput);
		},
		enqueueMany(env: Env, inputs: readonly TypedEnqueueInput<PerformersOf<R>>[]): Promise<string[]> {
			assertConfigured(env);
			return client.enqueueMany(env, inputs as unknown as readonly EnqueueInput[]);
		},
		start,
		runFor,
		// flow定義を参照するクラスをここで作る, パッケージから直接エクスポートできない理由(ADR-0030)
		runClass: createRunClass({
			flows,
			bindings: config.bindings ?? {},
			...(config.runs ? { settings: config.runs } : {}),
			failureBinding: config.onFailure ?? null,
		}),
		// schedule定義を参照するクラス, 同上(ADR-0040)
		schedulerClass,
	};

	return handler as unknown as Tsumugi<EnvOf<R>, PerformersOf<R>, F>;
}
