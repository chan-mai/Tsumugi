import { Hono } from 'hono';
import { cachedCheck, migrationErrorMessage } from '../projection/migrations.js';
import {
	findJob,
	findRun,
	jobStats,
	listJobs,
	listProjectedBindings,
	listRuns,
	selectBulkTargets,
	type FailedRetention,
} from '../projection/queries.js';
import { InvalidJobIdError, InvalidRunIdError, parseRunId, shardName } from '../core/ids.js';
import { jobRetryable, runRetryable } from '../core/retention.js';
import type { MutationResult, TsumugiJobShard } from '../do/job-shard.js';
import type { ConsumerEnv } from '../queue/consumer.js';
import type { Ui } from '../ui/serve.js';
import type { RunControlStub, SchedulerControl, StartOptions } from '../worker.js';
import type { AuthMiddleware } from './auth.js';
import { MetricsQueryError, parseMetricsQuery, readMetrics, type MetricsResolver } from '../analytics/reader.js';
import { eachShard, mutateJob, mutateJobs } from './control.js';
import { openapiDocument } from './openapi.js';
import { resolveSort } from './sort.js';
import {
	parseJobFilters,
	parsePaging,
	validateBulk,
	validateCreateJob,
	validatePolicy,
	validateReschedule,
	validateStartRun,
	type CreateJobInput,
} from './validate.js';
import type {
	BindingsResponse,
	CreateJobResponse,
	DiagnosticsResponse,
	ErrorResponse,
	FlowsResponse,
	JobDetailResponse,
	JobListResponse,
	JobSummary,
	MutationResponse,
	RunDetailResponse,
	RunListResponse,
	StartRunResponse,
	PartialPolicyResponse,
	UpdatePolicyResponse,
	SchedulesResponse,
	StatsResponse,
	TriggerScheduleResponse,
} from './types.js';

export type RestEnv = ConsumerEnv & { TSUMUGI_DB: D1Database };

const INVALID_JSON = Symbol('invalid json');
const INVALID_JSON_BODY = { error: 'body must be valid JSON' } satisfies ErrorResponse;

async function readJson(req: { json(): Promise<unknown> }): Promise<unknown> {
	try {
		return await req.json();
	} catch {
		return INVALID_JSON;
	}
}

export type RestOptions<Env extends RestEnv> = {
	dashboard?: Ui;
	/** 投入先の検証, 選択肢用, 省略時は検証なし */
	bindings?: readonly string[];
	/** 流量設定変更は全shardへ送信(#27) */
	shardsOf?: (binding: string) => number;
	enqueue?: (env: Env, input: CreateJobInput) => Promise<string>;
	/** binding毎の失敗ジョブ保持期間, 一覧`retryable`の事前判定用(ADR-0027) */
	failedRetentionMs?: (binding: string) => number;
	/** 失敗runの保持期間, 詳細`retryable`判定用(ADR-0034) */
	runFailedRetentionMs?: number;
	/** 開始先の検証, 選択肢用, 省略時は検証なし */
	flows?: readonly string[];
	start?: (env: Env, flow: string, input: unknown, options?: StartOptions) => Promise<string>;
	/** 取り消し, 再開はDOへ直接送信, 読み取りモデルは正でない(ADR-0015) */
	runFor?: (env: Env, runId: string) => Pick<RunControlStub, 'cancel' | 'retry'>;
	/** 定期実行の照会, 操作, Scheduler DOへ直接送信(ADR-0040), 未設定時`/api/schedules`は501 */
	schedulerFor?: (env: Env) => Pick<SchedulerControl, 'list' | 'setPaused' | 'trigger'>;
	/** 未設定時`/api/metrics`は501 */
	metrics?: MetricsResolver<Env>;
};

// goneは410, 未作成と保持期間後の削除は区別不能, 状態違いの409とは利用者の対応が異なる
function refusal(result: { ok: false; reason: 'invalid-state' | 'gone' }, subject: 'job' | 'run' = 'job') {
	return result.reason === 'gone'
		? ({
				body: { error: `${subject} not found: it does not exist or was removed after the retention period` } satisfies ErrorResponse,
				status: 410,
			} as const)
		: ({ body: { error: 'not allowed in the current state' } satisfies ErrorResponse, status: 409 } as const);
}

// 一部shardのみ反映時の応答, 成功扱いでは未停止の投入を停止済みと誤認(#27)
const partial = (binding: string, shards: number, failed: number[]) =>
	({
		error: `the change reached ${shards - failed.length} of ${shards} shards, send the same request again`,
		binding,
		shards,
		failed,
	}) satisfies PartialPolicyResponse;

export function createRest<Env extends RestEnv>(auth: AuthMiddleware, options: RestOptions<Env> = {}): Hono<{ Bindings: Env }> {
	const { dashboard, bindings, shardsOf, enqueue, failedRetentionMs, runFailedRetentionMs, flows, start, runFor, schedulerFor, metrics } =
		options;

	const withRetryable = <T extends { state: string; binding: string; updated_at: number }>(
		row: T,
		now: number,
	): T & { retryable: boolean } => ({
		...row,
		retryable: jobRetryable({ state: row.state, updatedAt: row.updated_at }, now, failedRetentionMs?.(row.binding)),
	});
	const retention: FailedRetention | undefined = failedRetentionMs ? { of: failedRetentionMs, bindings } : undefined;

	const app = new Hono<{ Bindings: Env }>();
	// HTMLはデータを含まず, 未認証で返却しSPAでトークン入力欄を表示(ADR-0013)
	app.use('/api/*', auth);

	// D1不使用, マイグレーション検査前に配置し適用漏れ環境でも取得可能
	const document = openapiDocument();
	app.get('/api/openapi.json', (c) => c.json(document));

	// マイグレーション適用漏れの検出, 未検査ではD1のraw errorのみで原因判別不能
	const checkSchema = cachedCheck();
	app.use('/api/*', async (c, next) => {
		const status = await checkSchema(c.env.TSUMUGI_DB);
		if (!status.ok) {
			// 適用漏れ時のみ復旧コマンド案内, 一時障害で適用済み環境への誤案内回避(#8)
			const error = 'missing' in status ? migrationErrorMessage(status.missing) : 'database temporarily unavailable';
			return c.json({ error }, 503);
		}
		await next();
	});

	app.get('/api/jobs', async (c) => {
		const url = new URL(c.req.url);
		const { jobs, total } = await listJobs(c.env.TSUMUGI_DB, {
			state: url.searchParams.get('state'),
			binding: url.searchParams.get('binding'),
			...parsePaging(url),
			...resolveSort(url.searchParams.get('sort'), url.searchParams.get('order')),
			...parseJobFilters(url),
		});
		const now = Date.now();
		const body: JobListResponse = { jobs: jobs.map((row) => withRetryable(row, now) satisfies JobSummary), total };
		return c.json(body);
	});

	// 登録済みperformerを返却, 投影済みbindingのみでは未実行のものを選択不能
	app.get('/api/bindings', async (c) => {
		if (bindings !== undefined) return c.json({ bindings: [...bindings].sort() } satisfies BindingsResponse);
		return c.json({ bindings: await listProjectedBindings(c.env.TSUMUGI_DB) } satisfies BindingsResponse);
	});

	app.post('/api/jobs', async (c) => {
		if (!enqueue) return c.json({ error: 'job creation is not available' } satisfies ErrorResponse, 501);

		const body = await readJson(c.req);
		if (body === INVALID_JSON) return c.json(INVALID_JSON_BODY, 400);

		const parsed = validateCreateJob(body, bindings, c.req.header('traceparent'));
		if ('error' in parsed) return c.json({ error: parsed.error } satisfies ErrorResponse, 400);

		let id: string;
		try {
			id = await enqueue(c.env, parsed.input);
		} catch (error) {
			// 分割構成のpartitionKey欠落, binding名の不正は入力の誤り
			if (error instanceof InvalidJobIdError) return c.json({ error: error.message } satisfies ErrorResponse, 400);
			throw error;
		}
		return c.json({ id } satisfies CreateJobResponse, 201);
	});

	// D1明細はsweepで削除, ここは保持期間の長い時系列から取得
	app.get('/api/metrics', async (c) => {
		const config = metrics?.(c.env);
		if (!config) return c.json({ error: 'metrics is not configured' }, 501);

		const parsed = parseMetricsQuery(new URL(c.req.url));
		if ('error' in parsed) return c.json({ error: parsed.error }, 400);

		try {
			return c.json(await readMetrics(config, parsed.query));
		} catch (error) {
			// 上流失敗は502, 500では設定誤りと区別不能
			if (error instanceof MetricsQueryError) return c.json({ error: error.message }, 502);
			throw error;
		}
	});

	// 対象は読み取りモデルから取得, 横断的な抽出はDOへ問い合わせ不能(ADR-0008)
	// 一部拒否でも全体は成功扱い, 全体失敗では成功分も再送発生
	for (const action of ['retry', 'cancel'] as const) {
		app.post(`/api/jobs/bulk-${action}`, async (c) => {
			const body = await readJson(c.req);
			if (body === INVALID_JSON) return c.json(INVALID_JSON_BODY, 400);

			const parsed = validateBulk(body, action);
			if ('error' in parsed) return c.json({ error: parsed.error } satisfies ErrorResponse, 400);
			const target = parsed.input;

			const { ids, remaining } =
				target.kind === 'ids'
					? { ids: target.ids, remaining: 0 }
					: await selectBulkTargets(c.env.TSUMUGI_DB, action, target, retention, Date.now());
			const { ok, failed } = await mutateJobs(c.env, action, ids);
			return c.json({ ok, failed, remaining }, 200);
		});
	}

	app.get('/api/stats', async (c) => {
		const { byState, oldestScheduledAt } = await jobStats(c.env.TSUMUGI_DB);
		// 読み取りモデル経由で数秒遅延, 傾向把握用
		const body: StatsResponse = {
			byState,
			oldestScheduledMs: oldestScheduledAt === null ? null : Math.max(0, Date.now() - oldestScheduledAt),
		};
		return c.json(body);
	});

	// 既定のshards=1でshard 0を照会, 分割時もshard 0のみ(ADR-0011)
	app.get('/api/diagnostics', async (c) => {
		const perBinding = await Promise.all(
			(bindings ?? []).map(async (binding) => {
				const stub = c.env.JOB_SHARD.get(c.env.JOB_SHARD.idFromName(shardName(binding, 0)));
				return [binding, await stub.diagnostics()] as const;
			}),
		);
		const body: DiagnosticsResponse = { shard: 0, bindings: Object.fromEntries(perBinding) };
		return c.json(body);
	});

	const shardCountOf = (binding: string) => Math.max(1, shardsOf?.(binding) ?? 1);

	app.post('/api/bindings/:binding/policy', async (c) => {
		const binding = c.req.param('binding');
		if (bindings !== undefined && !bindings.includes(binding))
			return c.json({ error: `unknown binding: ${binding}` } satisfies ErrorResponse, 404);

		const body = await readJson(c.req);
		if (body === INVALID_JSON) return c.json(INVALID_JSON_BODY, 400);

		const parsed = validatePolicy(body);
		if ('error' in parsed) return c.json({ error: parsed.error } satisfies ErrorResponse, 400);

		const shards = shardCountOf(binding);
		const { failed, applied } = await eachShard(c.env, binding, shards, (stub) => stub.updatePolicy(parsed.input));
		if (failed.length > 0) return c.json(partial(binding, shards, failed), 500);
		// 全shard同一内容, 先頭の結果を代表として返却
		const policy = applied[0] as UpdatePolicyResponse['policy'];
		return c.json({ binding, shards, policy } satisfies UpdatePolicyResponse);
	});

	// 実行時設定を破棄し静的設定へ復帰(#27), 次回投入の同梱設定で再度有効化(#6)
	app.post('/api/bindings/:binding/policy/reset', async (c) => {
		const binding = c.req.param('binding');
		if (bindings !== undefined && !bindings.includes(binding))
			return c.json({ error: `unknown binding: ${binding}` } satisfies ErrorResponse, 404);

		const shards = shardCountOf(binding);
		const { failed } = await eachShard(c.env, binding, shards, (stub) => stub.resetPolicy());
		if (failed.length > 0) return c.json(partial(binding, shards, failed), 500);
		return c.json({ ok: true } satisfies MutationResponse);
	});

	// 定義と状態はScheduler DOが正で直接照会(ADR-0040)
	app.get('/api/schedules', async (c) => {
		if (!schedulerFor) return c.json({ error: 'schedules are not available' } satisfies ErrorResponse, 501);
		const schedules = await schedulerFor(c.env).list();
		return c.json({ schedules } satisfies SchedulesResponse);
	});

	for (const [action, paused] of [
		['pause', true],
		['resume', false],
	] as const) {
		app.post(`/api/schedules/:name/${action}`, async (c) => {
			if (!schedulerFor) return c.json({ error: 'schedules are not available' } satisfies ErrorResponse, 501);
			const name = c.req.param('name');
			const result = await schedulerFor(c.env).setPaused(name, paused);
			if (result.ok) return c.json({ ok: true } satisfies MutationResponse, 200);
			return c.json({ error: `unknown schedule: ${name}` } satisfies ErrorResponse, 404);
		});
	}

	// 一時停止中も実行可, 次回予定は不変
	app.post('/api/schedules/:name/trigger', async (c) => {
		if (!schedulerFor) return c.json({ error: 'schedules are not available' } satisfies ErrorResponse, 501);
		const name = c.req.param('name');
		const result = await schedulerFor(c.env).trigger(name);
		if (result.ok) return c.json({ id: result.id, kind: result.kind } satisfies TriggerScheduleResponse, 201);
		if (result.reason === 'unknown') return c.json({ error: `unknown schedule: ${name}` } satisfies ErrorResponse, 404);
		// 写像関数, 投入の失敗, 理由は一覧のlast_errorにも記録
		return c.json({ error: result.error } satisfies ErrorResponse, 500);
	});

	app.get('/api/jobs/:id', async (c) => {
		const found = await findJob(c.env.TSUMUGI_DB, c.req.param('id'));
		if (!found) return c.json({ error: 'not found' } satisfies ErrorResponse, 404);
		return c.json({ job: withRetryable(found, Date.now()) } satisfies JobDetailResponse);
	});

	const jobMutation = async (env: Env, id: string, apply: (stub: DurableObjectStub<TsumugiJobShard>) => Promise<MutationResult>) => {
		try {
			const result = await mutateJob(env, id, apply);
			if (result.ok) {
				return { body: { ok: true, ...(result.requested ? { requested: true } : {}) } satisfies MutationResponse, status: 200 } as const;
			}
			return refusal(result);
		} catch (error) {
			if (error instanceof InvalidJobIdError) return { body: { error: 'invalid job id' } satisfies ErrorResponse, status: 400 } as const;
			throw error;
		}
	};

	app.post('/api/jobs/:id/retry', async (c) => {
		const id = c.req.param('id');
		const { body, status } = await jobMutation(c.env, id, (stub) => stub.retry(id));
		return c.json(body, status);
	});

	app.post('/api/jobs/:id/reschedule', async (c) => {
		const id = c.req.param('id');

		const body = await readJson(c.req);
		if (body === INVALID_JSON) return c.json(INVALID_JSON_BODY, 400);

		const parsed = validateReschedule(body, Date.now());
		if ('error' in parsed) return c.json({ error: parsed.error } satisfies ErrorResponse, 400);

		// SCHEDULED以外は予定変更でも実行継続, DO側で拒否
		const { body: result, status } = await jobMutation(c.env, id, (stub) => stub.reschedule(id, parsed.input));
		return c.json(result, status);
	});

	app.post('/api/jobs/:id/cancel', async (c) => {
		const id = c.req.param('id');
		// SCHEDULEDは即時, QUEUED / RUNNINGは要求の受理(ADR-0052)
		const { body, status } = await jobMutation(c.env, id, (stub) => stub.cancel(id));
		return c.json(body, status);
	});

	// Run DOはrun毎に独立, 横断一覧は読み取りモデルからのみ取得可能
	app.get('/api/runs', async (c) => {
		const url = new URL(c.req.url);
		const body: RunListResponse = await listRuns(c.env.TSUMUGI_DB, {
			state: url.searchParams.get('state'),
			flow: url.searchParams.get('flow'),
			...parsePaging(url),
		});
		return c.json(body);
	});

	// 未実行flowも含め`flows`から返却
	app.get('/api/flows', (c) => c.json({ flows: [...(flows ?? [])].sort() } satisfies FlowsResponse));

	app.post('/api/runs', async (c) => {
		if (!start) return c.json({ error: 'run creation is not available' } satisfies ErrorResponse, 501);

		const body = await readJson(c.req);
		if (body === INVALID_JSON) return c.json(INVALID_JSON_BODY, 400);

		const parsed = validateStartRun(body, flows);
		if ('error' in parsed) return c.json({ error: parsed.error } satisfies ErrorResponse, 400);

		const { flow, input, id, deadlineMs } = parsed.input;
		try {
			const started = await start(c.env, flow, input, {
				...(id !== undefined ? { id } : {}),
				...(deadlineMs !== undefined ? { deadlineMs } : {}),
			});
			return c.json({ id: started } satisfies StartRunResponse, 201);
		} catch (error) {
			// runIdのローカル部に使えないidは要求側の誤り, ジョブ側と同じ扱い
			if (error instanceof InvalidRunIdError) return c.json({ error: 'invalid run id' } satisfies ErrorResponse, 400);
			throw error;
		}
	});

	app.get('/api/runs/:id', async (c) => {
		const found = await findRun(c.env.TSUMUGI_DB, c.req.param('id'));
		if (!found) return c.json({ error: 'not found' } satisfies ErrorResponse, 404);
		const { run, nodes } = found;
		const retryable = runRetryable({ state: run.state, updatedAt: run.updated_at }, Date.now(), runFailedRetentionMs);
		return c.json({ run: { ...run, retryable }, nodes } satisfies RunDetailResponse);
	});

	// 取り消し, 再開は正であるRun DOへ送信
	// Honoのコンテキスト型非依存, 必要な値のみ引数で受け取り
	const runMutation = async (action: 'cancel' | 'retry', env: Env, id: string) => {
		if (!runFor) return { body: { error: 'run control is not available' } satisfies ErrorResponse, status: 501 } as const;
		try {
			parseRunId(id);
			const stub = runFor(env, id);
			const result = action === 'cancel' ? await stub.cancel() : await stub.retry();
			if (result.ok) return { body: { ok: true } satisfies MutationResponse, status: 200 } as const;
			return refusal(result, 'run');
		} catch (error) {
			if (error instanceof InvalidRunIdError) return { body: { error: 'invalid run id' } satisfies ErrorResponse, status: 400 } as const;
			throw error;
		}
	};

	app.post('/api/runs/:id/cancel', async (c) => {
		const { body, status } = await runMutation('cancel', c.env, c.req.param('id'));
		return c.json(body, status);
	});

	app.post('/api/runs/:id/retry', async (c) => {
		const { body, status } = await runMutation('retry', c.env, c.req.param('id'));
		return c.json(body, status);
	});

	// API以外のGETはSPAのHTMLを返却, ルーティングはクライアント側
	if (dashboard) {
		app.get('*', (c) => c.html(dashboard.render()));
	}

	return app;
}
