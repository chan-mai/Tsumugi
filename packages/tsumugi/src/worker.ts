import { createLocalId } from './do/local-id.js';
import { assertValidFlow, formatRunId, shardName } from './core/ids.js';
import { configOf, createClient, type BindingConfig, type ClientEnv, type EnqueueHook } from './client/enqueue.js';
import { TERMINAL_STATES } from './core/transitions.js';
import type { SettledState } from './core/types.js';
import type { DispatchMessage, EnqueueInput, TsumugiJobShard } from './do/job-shard.js';
import { createRunClass, type RunClass, type RunSettings } from './do/run.js';
import { DEFAULT_FAILED_RETENTION_MS } from './core/retention.js';
import { createSchedulerClass, SCHEDULER_DO_NAME, type SchedulerClass } from './do/scheduler.js';
import type { AnySchedules, ScheduleDefs } from './core/recurring.js';
import { handleBatch, type ConsumerEnv, type PerformerRegistry, type PerformerSource } from './queue/consumer.js';
import type { EnvOf, FailurePerformer, JobQueue, Performers, PerformersOf, SettledPerformer, TypedEnqueueInput } from './core/api.js';
import type { Flows, InputOf } from './core/flow.js';
import type { AuthMiddleware } from './api/auth.js';
import { createRest, type RestEnv } from './api/rest.js';
import { sweepReadModel, type SweepOptions } from './projection/sweep.js';
import type { Ui } from './ui/serve.js';
import type { MetricsResolver } from './analytics/reader.js';
import { cachedValidate } from './config/validate.js';
import { configErrorMessage } from './config/fragment.js';

import type { RunControlStub, SchedulerControl, StartOptions } from './do/control.js';

export type { BindingConfig, ClientEnv, RunControlStub, SchedulerControl, StartOptions };

/** flows利用時のみ必要, 未設定時は開始時エラー(ADR-0013) */
export type RunNamespaceEnv = {
	RUN?: DurableObjectNamespace<RunControlStub>;
};

/** schedules利用時のみ必要, 未設定時は起動時検証で報告(ADR-0013) */
export type SchedulerNamespaceEnv = {
	SCHEDULER?: DurableObjectNamespace<SchedulerControl>;
};

export type TsumugiConfig<Env extends ConsumerEnv> = {
	/**
	 * binding名とperformerモジュールの対応, 実行時は`ctx.exports`で解決(ADR-0037)
	 * enqueueのpayloadと必須キーの型の推論元(ADR-0010)
	 */
	performers: PerformerRegistry<Env>;
	/** 指定時のみRun DOのエクスポートとbindingが必要(ADR-0030) */
	flows?: Flows;
	/**
	 * FAILED/STALLEDのジョブの通知先binding, payloadは`FailureNotice`(#30)
	 * 通知ジョブ自体の失敗は対象外, 自己循環防止
	 */
	onFailure?: string;
	/**
	 * statesの終端状態に達したジョブの通知先binding, payloadは`SettledNotice`(#96)
	 * 宛先自身とonFailure宛先の遷移は対象外, 自己循環と相互連鎖防止
	 * onFailure併用時のFAILED/STALLEDは両方へ通知
	 */
	onSettled?: { binding: string; states: readonly SettledState[] };
	/**
	 * 投入時の既定値付与フック, 呼び出し側の明示値優先(#96)
	 * worker/Run DO/Scheduler DOの投入に適用, onFailure/onSettledの通知ジョブには非適用
	 */
	onEnqueue?: EnqueueHook;
	/**
	 * 指定時のみScheduler DOのエクスポートとbindingが必要(ADR-0040)
	 * binding名とpayloadの型は`defineTsumugi`のインライン型で`performers`から強制
	 */
	schedules?: ScheduleDefs<any, any>;
	runs?: RunSettings;
	bindings?: Record<string, BindingConfig>;
	/**
	 * 認証ミドルウェア, 未設定ならREST APIとダッシュボード無効(ADR-0013)
	 * 同梱`bearerAuth`か独自の認証関数, 認証無しは`unsafeNoAuth`を明示(ADR-0044)
	 */
	auth?: AuthMiddleware<Env>;
	/** `tsumugi/ui`の`ui()`, 未使用時はバンドル対象外(ADR-0025) */
	ui?: Ui;
	/** D1読み取りモデルの保持設定, cronトリガー設定時は`scheduled`で古い終端ジョブ削除 */
	retention?: SweepOptions;
	/**
	 * Analytics Engine読み取り設定, アカウントのAPIトークンを`env`から取得する関数
	 * 未設定ならメトリクス画面とAPI無効
	 */
	metrics?: MetricsResolver<Env>;
};

/** `defineTsumugi`の戻り値, 必須キー漏れはコンパイルエラー(ADR-0010) */
export type Tsumugi<Env, M extends Performers = Performers, F extends Flows = Flows> = ExportedHandler<Env> & {
	jobs(env: Env): JobQueue<M>;
	enqueue(env: Env, input: TypedEnqueueInput<M>): Promise<string>;
	enqueueMany(env: Env, inputs: readonly TypedEnqueueInput<M>[]): Promise<string[]>;
	shardFor(env: Env, binding: keyof M & string, partitionKey?: string): DurableObjectStub<TsumugiJobShard>;
	/**
	 * 同一`id`は同一runId, 再度の開始は既存runを返却(ADR-0029)
	 * `deadlineMs`はflow定義の期限より優先(ADR-0039)
	 */
	start<K extends keyof F & string>(env: Env, flow: K, input: InputOf<F[K]>, options?: StartOptions): Promise<string>;
	runFor(env: Env, runId: string): DurableObjectStub<RunControlStub>;
	/**
	 * Run DOクラス, flow定義参照でパッケージから直接エクスポート不可(ADR-0030)
	 * wranglerのclass_nameはエクスポート名
	 */
	runClass: RunClass;
	/** Scheduler DOクラス, schedules定義参照でパッケージから直接エクスポート不可(ADR-0040) */
	schedulerClass: SchedulerClass;
};

/** shards=1の既定構成向け, 常に0番(ADR-0011) */
export function shardAt<Env extends ConsumerEnv>(env: Env, binding: string, shard = 0): DurableObjectStub<TsumugiJobShard> {
	return env.JOB_SHARD.get(env.JOB_SHARD.idFromName(shardName(binding, shard)));
}

export async function enqueue<Env extends ConsumerEnv>(env: Env, input: EnqueueInput): Promise<string> {
	return createClient<Env>().enqueue(env, input);
}

export async function enqueueMany<Env extends ConsumerEnv>(env: Env, inputs: readonly EnqueueInput[]): Promise<string[]> {
	return createClient<Env>().enqueueMany(env, inputs);
}

/** `M`と`Env`は`config.performers`から推論, 明示の型引数不要(ADR-0010) */
export function defineTsumugi<const R extends PerformerRegistry<any>, const F extends Flows = {}>(
	// schedules等はR/F参照でOmit不可, NoInferで推論対象外
	config: {
		performers: R;
		flows?: F;
		schedules?: ScheduleDefs<NoInfer<PerformersOf<R>>, NoInfer<F>>;
		onFailure?: FailurePerformer<NoInfer<PerformersOf<R>>>;
		onSettled?: { binding: SettledPerformer<NoInfer<PerformersOf<R>>>; states: readonly [SettledState, ...SettledState[]] };
	} & Omit<TsumugiConfig<any>, 'performers' | 'flows' | 'schedules' | 'onFailure' | 'onSettled'>,
): Tsumugi<EnvOf<R>, PerformersOf<R>, F> {
	type Env = ConsumerEnv & RestEnv & RunNamespaceEnv & SchedulerNamespaceEnv;
	// states空/不正値は起動時エラー, 発火時発覚では通知が無警告で欠落
	if (config.onSettled) {
		if (config.onSettled.states.length === 0) throw new Error('onSettled.states must not be empty');
		for (const state of config.onSettled.states) {
			if (!TERMINAL_STATES.includes(state)) throw new Error(`onSettled.states contains an invalid state: ${state}`);
		}
	}
	// 通知設定は毎投入でDOへ常時送信, 解除後の旧宛先送信防止(#30 / #96)
	const client = createClient<Env>(
		config.bindings ?? {},
		{ failureBinding: config.onFailure ?? null, settled: config.onSettled ?? null },
		config.onEnqueue ? { onEnqueue: config.onEnqueue } : {},
	);
	// 内部のみ緩い型, 公開型はperformersから推論
	const performers = config.performers as unknown as PerformerRegistry<Env>;
	const flows: Flows = config.flows ?? {};
	const schedules: AnySchedules = (config.schedules ?? {}) as AnySchedules;
	// flow名はrunIdの一部, 起動時検証(ADR-0029)
	for (const flow of Object.keys(flows)) assertValidFlow(flow);
	// 未登録subflowは子runId決定不能, 起動時エラー
	const registered = new Set(Object.values(flows));
	for (const [name, flow] of Object.entries(flows)) {
		for (const node of flow.nodes) {
			if (node.subflow && !registered.has(node.subflow)) throw new Error(`subflow target is not registered: ${name}.${node.id}`);
		}
	}

	// schedule定義誤りはここでエラー, 発火時発覚では無警告停止(ADR-0040)
	const schedulerClass = createSchedulerClass({
		schedules,
		bindings: config.bindings ?? {},
		targets: { bindings: Object.keys(performers), flows: Object.keys(flows) },
		failureBinding: config.onFailure ?? null,
		settled: config.onSettled ?? null,
		...(config.onEnqueue ? { onEnqueue: config.onEnqueue } : {}),
	});

	// Workersに起動フック無し, 初回呼び出し時に検証(ADR-0036)
	const checkConfig = cachedValidate({ performers, flows, schedules });

	const assertConfigured = (env: Env): void => {
		const status = checkConfig(env as unknown as Record<string, unknown>);
		if (!status.ok) throw new Error(configErrorMessage(status.missing));
	};

	// 設定漏れは開始時エラー, 放置ではノード永久未実行(ADR-0013)
	const runFor = (env: Env, runId: string): DurableObjectStub<RunControlStub> => {
		const namespace = env.RUN;
		// RUNのみ個別判定, 不足一覧より短いメッセージ
		if (!namespace) throw new Error('RUN binding is not configured, add the Run DO binding to wrangler');
		return namespace.get(namespace.idFromName(runId));
	};

	const schedulerFor = (env: Env): DurableObjectStub<SchedulerControl> => {
		const namespace = env.SCHEDULER;
		// SCHEDULERのみ個別判定, 不足一覧より短いメッセージ
		if (!namespace) throw new Error('SCHEDULER binding is not configured, add the Scheduler DO binding to wrangler');
		return namespace.get(namespace.idFromName(SCHEDULER_DO_NAME));
	};

	// Scheduler DO同期はisolateごとに1回, alarm設定後は継続(ADR-0040)
	let primed: Promise<void> | undefined;
	const prime = (env: Env, ctx: ExecutionContext): void => {
		if (Object.keys(schedules).length === 0 || primed !== undefined) return;
		// binding不足はcachedValidateで報告, ここでのエラーは全リクエスト失敗
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
		const runId = formatRunId({ flow, localId: options?.id ?? createLocalId() });
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
				// 流量変更の全shard適用用(#27)
				shardsOf: (binding) => configOf(config.bindings ?? {}, binding)?.shards ?? 1,
				enqueue: (env, input) => client.enqueue(env, input),
				// 一覧のretryable判定用, 操作前の可否表示(ADR-0027)
				failedRetentionMs: (binding) => configOf(config.bindings ?? {}, binding)?.failedRetentionMs ?? DEFAULT_FAILED_RETENTION_MS,
				runFailedRetentionMs: config.runs?.failedRetentionMs ?? DEFAULT_FAILED_RETENTION_MS,
				flows: Object.keys(flows),
				// 未設定時`/api/metrics`は501
				...(config.metrics ? { metrics: config.metrics as MetricsResolver<Env> } : {}),
				// flow無し構成で渡すと501でなく500
				...(Object.keys(flows).length > 0 ? { start, runFor } : {}),
				// schedule無しなら`/api/schedules`は501
				...(Object.keys(schedules).length > 0 ? { schedulerFor } : {}),
			})
		: null;

	const handler = {
		async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
			prime(env, ctx);
			// 認証未設定は全404, 設定漏れを動作停止として明示(ADR-0013)
			if (!rest) return new Response('not found', { status: 404 });

			// binding不足はマイグレーション未適用と同じく構成不備の503(ADR-0036)
			const status = checkConfig(env as unknown as Record<string, unknown>);
			if (!status.ok && new URL(request.url).pathname.startsWith('/api/')) {
				return Response.json({ error: configErrorMessage(status.missing), missing: status.missing }, { status: 503 });
			}
			return rest.fetch(request, env, ctx);
		},
		async queue(batch: MessageBatch<DispatchMessage>, env: Env, ctx: ExecutionContext): Promise<void> {
			prime(env, ctx);
			// performerは`ctx.exports`から取得, 別途binding不要(ADR-0037)
			await handleBatch(batch, env, (ctx as unknown as { exports?: PerformerSource }).exports ?? {});
		},
		async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
			prime(env, ctx);
			// D1読み取りモデルのみ, DO側はtickで削除
			const jobs = Object.fromEntries(
				Object.entries(config.bindings ?? {}).flatMap(([binding, c]) =>
					c.failedRetentionMs === undefined ? [] : [[binding, c.failedRetentionMs]],
				),
			);
			const removed = await sweepReadModel(env.TSUMUGI_DB, Date.now(), config.retention ?? {}, {
				jobs,
				...(config.runs?.failedRetentionMs !== undefined ? { runs: config.runs.failedRetentionMs } : {}),
			});
			if (removed > 0) console.log(`tsumugi: swept ${removed} jobs and runs from the read model`);
		},
		jobs(env: Env): JobQueue<PerformersOf<R>> {
			return {
				// 型はJobQueue<M>で制約
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
			// TypedEnqueueInputはEnqueueInputの部分集合
			return client.enqueue(env, input as unknown as EnqueueInput);
		},
		enqueueMany(env: Env, inputs: readonly TypedEnqueueInput<PerformersOf<R>>[]): Promise<string[]> {
			assertConfigured(env);
			return client.enqueueMany(env, inputs as unknown as readonly EnqueueInput[]);
		},
		start,
		runFor,
		// flow定義参照, パッケージから直接エクスポート不可(ADR-0030)
		runClass: createRunClass({
			flows,
			bindings: config.bindings ?? {},
			...(config.runs ? { settings: config.runs } : {}),
			failureBinding: config.onFailure ?? null,
			settled: config.onSettled ?? null,
			...(config.onEnqueue ? { onEnqueue: config.onEnqueue } : {}),
		}),
		// schedule定義参照, 同上(ADR-0040)
		schedulerClass,
	};

	return handler as unknown as Tsumugi<EnvOf<R>, PerformersOf<R>, F>;
}
