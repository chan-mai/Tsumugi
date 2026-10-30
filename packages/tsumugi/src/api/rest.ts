import { cachedCheck, migrationErrorMessage } from '../projection/migrations.js';
import { parseMetricsQuery } from '../analytics/reader.js';
import { createBindingService } from '../service/bindings.service.js';
import { createJobService } from '../service/jobs.service.js';
import { createMetricsService } from '../service/metrics.service.js';
import { createRunService } from '../service/runs.service.js';
import { createScheduleService } from '../service/schedules.service.js';
import type { MutationOutcome, ServiceEnv, ServiceOptions } from '../service/types.js';
import type { Ui } from '../ui/serve.js';
import type { AuthMiddleware } from './auth.js';
import { createRouter, type Route } from './router.js';
import { SORT_KEYS, toJobDetail, toJobSummary, toRunDetail, toRunNode, toRunSummary } from './mapper.js';
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
} from './validate.js';
import type {
	BindingsResponse,
	CreateJobResponse,
	DiagnosticsResponse,
	ErrorResponse,
	FlowsResponse,
	JobDetailResponse,
	JobListResponse,
	MutationResponse,
	PartialPolicyResponse,
	RunDetailResponse,
	RunListResponse,
	SchedulesResponse,
	StartRunResponse,
	StatsResponse,
	TriggerScheduleResponse,
	UpdatePolicyResponse,
} from './types.js';

export type RestEnv = ServiceEnv;

export type RestOptions<Env extends RestEnv> = ServiceOptions<Env> & { dashboard?: Ui };

export type Rest<Env> = {
	fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response>;
	readonly routes: readonly Route[];
};

const INVALID_JSON = Symbol('invalid json');
const INVALID_JSON_BODY = { error: 'body must be valid JSON' } satisfies ErrorResponse;

async function readJson(req: { json(): Promise<unknown> }): Promise<unknown> {
	try {
		return await req.json();
	} catch {
		return INVALID_JSON;
	}
}

const error = (message: string) => ({ error: message }) satisfies ErrorResponse;

// goneは410, 未作成と保持期間後の削除は区別不能, 状態違いの409とは利用者の対応が異なる
function mutationResponse(outcome: MutationOutcome, subject: 'job' | 'run') {
	if (outcome.ok)
		return { body: { ok: true, ...(outcome.requested ? { requested: true } : {}) } satisfies MutationResponse, status: 200 } as const;
	switch (outcome.reason) {
		case 'gone':
			return { body: error(`${subject} not found: it does not exist or was removed after the retention period`), status: 410 } as const;
		case 'invalid-id':
			return { body: error(`invalid ${subject} id`), status: 400 } as const;
		default:
			return { body: error('not allowed in the current state'), status: 409 } as const;
	}
}

// 一部shardのみ反映時の応答, 成功扱いでは未停止の投入を停止済みと誤認(#27)
const partial = (binding: string, shards: number, failed: number[]) =>
	({
		error: `the change reached ${shards - failed.length} of ${shards} shards, send the same request again`,
		binding,
		shards,
		failed,
	}) satisfies PartialPolicyResponse;

export function createRest<Env extends RestEnv>(auth: AuthMiddleware<Env>, options: RestOptions<Env> = {}): Rest<Env> {
	const { dashboard, bindings, flows } = options;
	const jobs = createJobService(options);
	const runs = createRunService(options);
	const bindingService = createBindingService(options);
	const schedules = createScheduleService(options);
	const metrics = createMetricsService(options);

	const app = createRouter<Env>();
	// HTMLはデータを含まず, 未認証で返却しSPAでトークン入力欄を表示(ADR-0013)
	app.use('/api/*', (c) => auth(c.req.raw, c.env));

	// D1不使用, マイグレーション検査前に配置し適用漏れ環境でも取得可能
	const document = openapiDocument();
	app.get('/api/openapi.json', (c) => c.json(document));

	// マイグレーション適用漏れの検出, 未検査ではD1のraw errorのみで原因判別不能
	const checkSchema = cachedCheck();
	app.use('/api/*', async (c) => {
		const status = await checkSchema(c.env.TSUMUGI_DB);
		if (!status.ok) {
			// 適用漏れ時のみ復旧コマンド案内, 一時障害で適用済み環境への誤案内回避(#8)
			const message = 'missing' in status ? migrationErrorMessage(status.missing) : 'database temporarily unavailable';
			return c.json({ error: message }, 503);
		}
		return undefined;
	});

	app.get('/api/jobs', async (c) => {
		const url = new URL(c.req.url);
		const { column, desc } = resolveSort(url.searchParams.get('sort'), url.searchParams.get('order'));
		const { jobs: found, total } = await jobs.list(c.env, {
			state: url.searchParams.get('state'),
			binding: url.searchParams.get('binding'),
			...parsePaging(url),
			sort: SORT_KEYS[column],
			desc,
			...parseJobFilters(url),
		});
		return c.json({ jobs: found.map(toJobSummary), total } satisfies JobListResponse);
	});

	app.get('/api/bindings', async (c) => c.json({ bindings: await bindingService.list(c.env) } satisfies BindingsResponse));

	app.post('/api/jobs', async (c) => {
		const create = jobs.create;
		if (!create) return c.json(error('job creation is not available'), 501);

		const body = await readJson(c.req);
		if (body === INVALID_JSON) return c.json(INVALID_JSON_BODY, 400);

		const parsed = validateCreateJob(body, bindings, c.req.header('traceparent'));
		if ('error' in parsed) return c.json(error(parsed.error), 400);

		const created = await create(c.env, parsed.input);
		if (created.ok) return c.json({ id: created.id } satisfies CreateJobResponse, 201);
		return c.json(error(created.message), 400);
	});

	app.get('/api/metrics', async (c) => {
		const config = metrics.configOf(c.env);
		if (!config) return c.json(error('metrics is not configured'), 501);

		const parsed = parseMetricsQuery(new URL(c.req.url));
		if ('error' in parsed) return c.json(error(parsed.error), 400);

		const result = await metrics.read(config, parsed.query);
		if (result.ok) return c.json(result.metrics);
		// 上流失敗は502, 500では設定誤りと区別不能
		return c.json(error(result.message), 502);
	});

	for (const action of ['retry', 'cancel'] as const) {
		app.post(`/api/jobs/bulk-${action}`, async (c) => {
			const body = await readJson(c.req);
			if (body === INVALID_JSON) return c.json(INVALID_JSON_BODY, 400);

			const parsed = validateBulk(body, action);
			if ('error' in parsed) return c.json(error(parsed.error), 400);
			return c.json(await jobs.bulk(c.env, action, parsed.input), 200);
		});
	}

	app.get('/api/stats', async (c) => c.json((await jobs.stats(c.env)) satisfies StatsResponse));

	app.get('/api/diagnostics', async (c) => c.json((await bindingService.diagnostics(c.env)) satisfies DiagnosticsResponse));

	app.post('/api/bindings/:binding/policy', async (c) => {
		const binding = c.req.param('binding');
		if (!bindingService.isKnown(binding)) return c.json(error(`unknown binding: ${binding}`), 404);

		const body = await readJson(c.req);
		if (body === INVALID_JSON) return c.json(INVALID_JSON_BODY, 400);

		const parsed = validatePolicy(body);
		if ('error' in parsed) return c.json(error(parsed.error), 400);

		const result = await bindingService.updatePolicy(c.env, binding, parsed.input);
		if (result.ok) return c.json({ binding, shards: result.shards, policy: result.policy } satisfies UpdatePolicyResponse);
		return c.json(partial(binding, result.shards, result.failed), 500);
	});

	app.post('/api/bindings/:binding/policy/reset', async (c) => {
		const binding = c.req.param('binding');
		if (!bindingService.isKnown(binding)) return c.json(error(`unknown binding: ${binding}`), 404);

		const result = await bindingService.resetPolicy(c.env, binding);
		if (result.ok) return c.json({ ok: true } satisfies MutationResponse);
		return c.json(partial(binding, result.shards, result.failed), 500);
	});

	app.get('/api/schedules', async (c) => {
		const result = await schedules.list(c.env);
		if (!result.ok) return c.json(error('schedules are not available'), 501);
		return c.json({ schedules: result.schedules } satisfies SchedulesResponse);
	});

	for (const [action, paused] of [
		['pause', true],
		['resume', false],
	] as const) {
		app.post(`/api/schedules/:name/${action}`, async (c) => {
			const name = c.req.param('name');
			const result = await schedules.setPaused(c.env, name, paused);
			if (result.ok) return c.json({ ok: true } satisfies MutationResponse, 200);
			if (result.reason === 'unavailable') return c.json(error('schedules are not available'), 501);
			return c.json(error(`unknown schedule: ${name}`), 404);
		});
	}

	app.post('/api/schedules/:name/trigger', async (c) => {
		const name = c.req.param('name');
		const result = await schedules.trigger(c.env, name);
		if (result.ok) return c.json({ id: result.id, kind: result.kind } satisfies TriggerScheduleResponse, 201);
		if (result.reason === 'unavailable') return c.json(error('schedules are not available'), 501);
		if (result.reason === 'unknown') return c.json(error(`unknown schedule: ${name}`), 404);
		// 写像関数, 投入の失敗, 理由は一覧のlast_errorにも記録
		return c.json(error(result.error), 500);
	});

	app.get('/api/jobs/:id', async (c) => {
		const job = await jobs.detail(c.env, c.req.param('id'));
		if (!job) return c.json(error('not found'), 404);
		return c.json({ job: toJobDetail(job) } satisfies JobDetailResponse);
	});

	for (const action of ['retry', 'cancel'] as const) {
		app.post(`/api/jobs/:id/${action}`, async (c) => {
			const { body, status } = mutationResponse(await jobs.mutate(c.env, c.req.param('id'), { kind: action }), 'job');
			return c.json(body, status);
		});
	}

	app.post('/api/jobs/:id/reschedule', async (c) => {
		const body = await readJson(c.req);
		if (body === INVALID_JSON) return c.json(INVALID_JSON_BODY, 400);

		const parsed = validateReschedule(body, Date.now());
		if ('error' in parsed) return c.json(error(parsed.error), 400);

		const { body: result, status } = mutationResponse(
			await jobs.mutate(c.env, c.req.param('id'), { kind: 'reschedule', ...parsed.input }),
			'job',
		);
		return c.json(result, status);
	});

	app.get('/api/runs', async (c) => {
		const url = new URL(c.req.url);
		const { runs: found, total } = await runs.list(c.env, {
			state: url.searchParams.get('state'),
			flow: url.searchParams.get('flow'),
			...parsePaging(url),
		});
		return c.json({ runs: found.map(toRunSummary), total } satisfies RunListResponse);
	});

	app.get('/api/flows', (c) => c.json({ flows: runs.flows() } satisfies FlowsResponse));

	app.post('/api/runs', async (c) => {
		const start = runs.start;
		if (!start) return c.json(error('run creation is not available'), 501);

		const body = await readJson(c.req);
		if (body === INVALID_JSON) return c.json(INVALID_JSON_BODY, 400);

		const parsed = validateStartRun(body, flows);
		if ('error' in parsed) return c.json(error(parsed.error), 400);

		const started = await start(c.env, parsed.input);
		if (started.ok) return c.json({ id: started.id } satisfies StartRunResponse, 201);
		return c.json(error('invalid run id'), 400);
	});

	app.get('/api/runs/:id', async (c) => {
		const detail = await runs.detail(c.env, c.req.param('id'));
		if (!detail) return c.json(error('not found'), 404);
		return c.json({ run: toRunDetail(detail.run), nodes: detail.nodes.map(toRunNode) } satisfies RunDetailResponse);
	});

	for (const action of ['cancel', 'retry'] as const) {
		app.post(`/api/runs/:id/${action}`, async (c) => {
			const outcome = await runs.mutate(c.env, c.req.param('id'), action);
			if (!outcome.ok && outcome.reason === 'unavailable') return c.json(error('run control is not available'), 501);
			const { body, status } = mutationResponse(outcome, 'run');
			return c.json(body, status);
		});
	}

	// API以外のGETはSPAのHTMLを返却, ルーティングはクライアント側
	if (dashboard) {
		app.get('*', (c) => c.html(dashboard.render()));
	}

	return { routes: app.routes, fetch: (request, env) => app.fetch(request, env) };
}
