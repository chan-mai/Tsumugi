import { SORTABLE_COLUMNS } from './sort.js';

/**
 * REST APIのOpenAPI定義
 *
 * REST APIを叩くのはWorkers外の他言語の利用者なので, 仕様はOpenAPIで配る
 * `/api/openapi.json`が返す内容そのもので, 利用者はここから各言語のクライアントを生成する
 * 文面は英語で書く, 読み手が日本語話者に限らない
 * 構成によって501になる経路も載せる, 定義を構成ごとに変えると生成物が環境ごとに変わる
 */

/**
 * 定義に載せる版
 * package.jsonは実行時に読めないので写しを持つ, ずれは単体テストで突き合わせる
 */
export const API_VERSION = '0.3.0';

/** 3.1のJSON Schemaに沿う最小の型, 生成器へそのまま渡すので構造は緩く保つ */
export type OpenApiDocument = {
	openapi: string;
	info: { title: string; version: string; description?: string };
	paths: Record<string, Record<string, unknown>>;
	components: { schemas: Record<string, unknown>; securitySchemes?: Record<string, unknown> };
	security?: Record<string, string[]>[];
};

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const integer = (description?: string) => ({ type: 'integer', ...(description ? { description } : {}) });
const string = (description?: string) => ({ type: 'string', ...(description ? { description } : {}) });
const nullable = (type: string) => ({ type: [type, 'null'] });

/** 一覧と詳細で共通の列, 詳細はこれに足す形になる */
const JOB_SUMMARY_PROPERTIES = {
	id: string(),
	binding: string(),
	state: { type: 'string', enum: ['SCHEDULED', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'STALLED'] },
	priority: integer(),
	attempts: integer(),
	max_attempts: integer(),
	created_at: integer('epoch milliseconds'),
	updated_at: integer('epoch milliseconds'),
	dispatched_at: { ...nullable('integer'), description: 'When the job moved to QUEUED. Null while it has never been dispatched.' },
	retryable: {
		type: 'boolean',
		description: 'Approximation derived from the retention period. The retry response is the final answer.',
	},
} as const;

const JOB_SUMMARY_REQUIRED = Object.keys(JOB_SUMMARY_PROPERTIES);

const RUN_SUMMARY_PROPERTIES = {
	id: string(),
	flow: string(),
	state: { type: 'string', enum: ['RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'] },
	node_total: integer(),
	node_done: integer(),
	node_failed: integer(),
	created_at: integer('epoch milliseconds'),
	updated_at: integer('epoch milliseconds'),
} as const;

const RUN_SUMMARY_REQUIRED = Object.keys(RUN_SUMMARY_PROPERTIES);

const SCHEMAS: Record<string, unknown> = {
	Error: {
		type: 'object',
		properties: { error: string() },
		required: ['error'],
	},
	Mutation: {
		type: 'object',
		properties: { ok: { type: 'boolean', enum: [true] } },
		required: ['ok'],
	},
	JobSummary: {
		type: 'object',
		properties: JOB_SUMMARY_PROPERTIES,
		required: JOB_SUMMARY_REQUIRED,
	},
	AttemptRecord: {
		type: 'object',
		properties: {
			attempt: integer('1-based attempt number'),
			state: string(),
			started_at: nullable('integer'),
			finished_at: integer(),
			error: nullable('string'),
		},
		required: ['attempt', 'state', 'started_at', 'finished_at', 'error'],
	},
	JobDetail: {
		type: 'object',
		properties: {
			...JOB_SUMMARY_PROPERTIES,
			concurrency_key: nullable('string'),
			unique_key: nullable('string'),
			guarantee: { type: 'string', enum: ['at-least-once', 'at-most-once'] },
			run_after: { ...nullable('integer'), description: 'When a scheduled job becomes eligible to run.' },
			payload: string('JSON-encoded string'),
			result: { ...nullable('string'), description: 'JSON-encoded return value of perform. Present only on success.' },
			attempts_log: { type: 'array', items: ref('AttemptRecord'), description: 'Newest attempt first' },
		},
		required: [...JOB_SUMMARY_REQUIRED, 'concurrency_key', 'unique_key', 'guarantee', 'run_after', 'payload', 'result', 'attempts_log'],
	},
	CreateJobRequest: {
		type: 'object',
		properties: {
			binding: string('Name of a registered performer'),
			payload: { description: 'Any JSON value' },
			maxAttempts: { ...integer(), minimum: 1 },
			delayMs: { ...integer(), minimum: 0 },
			priority: integer(),
			concurrencyKey: string(),
			uniqueKey: string(),
		},
		required: ['binding', 'payload'],
	},
	RunSummary: {
		type: 'object',
		properties: RUN_SUMMARY_PROPERTIES,
		required: RUN_SUMMARY_REQUIRED,
	},
	RunDetail: {
		type: 'object',
		properties: {
			...RUN_SUMMARY_PROPERTIES,
			input: string('JSON-encoded string'),
			parent_run_id: { ...nullable('string'), description: 'Set when this run was started by a subflow node.' },
			parent_node_id: nullable('string'),
			retryable: { type: 'boolean', description: 'Only failed runs can be resumed.' },
		},
		required: [...RUN_SUMMARY_REQUIRED, 'input', 'parent_run_id', 'parent_node_id', 'retryable'],
	},
	RunNode: {
		type: 'object',
		properties: {
			id: string(),
			binding: string(),
			state: string(),
			container: { type: 'boolean', description: 'Fan-out node. Runs no job of its own and only holds child nodes.' },
			parent: nullable('string'),
			origin: { type: 'string', enum: ['static', 'fanOut', 'spawn'] },
			after: { type: 'array', items: string(), description: 'Node ids this node depends on' },
			job_id: nullable('string'),
			child_run_id: { ...nullable('string'), description: 'Set on subflow nodes, holding the run they started.' },
			result: { ...nullable('string'), description: 'Set on fan-out nodes only, holding the child summary.' },
			error: nullable('string'),
			position: integer('Display order'),
			created_at: integer(),
			updated_at: integer(),
		},
		required: [
			'id',
			'binding',
			'state',
			'container',
			'parent',
			'origin',
			'after',
			'job_id',
			'child_run_id',
			'result',
			'error',
			'position',
			'created_at',
			'updated_at',
		],
	},
	BulkRequest: {
		type: 'object',
		description: 'Either ids, or the filter fields. When ids is present the filter fields are ignored.',
		properties: {
			ids: { type: 'array', items: string(), minItems: 1, maxItems: 200, description: 'Job ids to process' },
			binding: string('Filter by performer binding name'),
			state: string('Only a state the operation accepts'),
			unique_key: string('Exact uniqueKey'),
			concurrency_key: string('Exact concurrencyKey'),
			created_from: integer('Lower bound of created_at, inclusive'),
			created_to: integer('Upper bound of created_at, inclusive'),
			limit: { ...integer('Jobs to process in one request'), minimum: 1, maximum: 200, default: 200 },
		},
	},
	BulkResult: {
		type: 'object',
		properties: {
			ok: { type: 'array', items: string(), description: 'Job ids the coordinator accepted' },
			failed: {
				type: 'array',
				description: 'Jobs the coordinator refused, with the reason',
				items: {
					type: 'object',
					properties: {
						id: string(),
						reason: {
							type: 'string',
							enum: ['invalid-state', 'gone', 'invalid-id'],
							description: 'invalid-state matches 409, gone matches 410, invalid-id is a malformed job id',
						},
					},
					required: ['id', 'reason'],
				},
			},
			remaining: integer('Estimated matches left after the limit. Always 0 when ids was given.'),
		},
		required: ['ok', 'failed', 'remaining'],
	},
	RescheduleRequest: {
		type: 'object',
		description: 'Exactly one of runAt and delayMs is required.',
		properties: {
			runAt: integer('Absolute epoch milliseconds'),
			delayMs: { ...integer('Relative to the time of the request'), minimum: 0 },
			priority: integer('Changed together with the schedule when present'),
		},
	},
	StartRunRequest: {
		type: 'object',
		properties: {
			flow: string('Name of a registered flow'),
			input: { description: 'Any JSON value' },
			id: string('Pins the run id. Starting twice with the same id returns the existing run.'),
		},
		required: ['flow', 'input'],
	},
	Diagnostics: {
		type: 'object',
		properties: {
			active: integer('Number of jobs in a non-terminal state'),
			outbox: integer('Number of rows waiting to be projected'),
			blocked: {
				type: 'object',
				description: 'Which limit stopped dispatching on the last tick',
				properties: {
					capacity: { type: 'boolean', description: 'Concurrency limit reached' },
					tokens: { type: 'boolean', description: 'Not enough rate tokens' },
					perKey: { type: 'boolean', description: 'Candidates skipped by the per-key concurrency limit' },
				},
				required: ['capacity', 'tokens', 'perKey'],
			},
		},
		required: ['active', 'outbox', 'blocked'],
	},
};

const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });

const RESPONSES = {
	unauthorized: { 401: { description: 'Authentication failed', ...json(ref('Error')) } },
	notFound: { 404: { description: 'Not found', ...json(ref('Error')) } },
	unavailable: { 503: { description: 'Database migrations are not applied, or D1 is temporarily unavailable', ...json(ref('Error')) } },
	mutation: {
		200: { description: 'Accepted', ...json(ref('Mutation')) },
		409: { description: 'Not allowed in the current state', ...json(ref('Error')) },
		410: { description: 'Removed from the coordinator after the retention period', ...json(ref('Error')) },
	},
	notImplemented: { 501: { description: 'Not available in this deployment', ...json(ref('Error')) } },
};

const badJobId = { 400: { description: 'Malformed job id', ...json(ref('Error')) } };
const badRunId = { 400: { description: 'Malformed run id', ...json(ref('Error')) } };
const badBody = { 400: { description: 'Invalid request body', ...json(ref('Error')) } };
// 400は1つしか書けないので, 本文とジョブIDの両方で断る経路は説明をまとめる
const badJobIdOrBody = { 400: { description: 'Malformed job id, or invalid request body', ...json(ref('Error')) } };

const queryParam = (name: string, schema: unknown, description?: string) => ({
	name,
	in: 'query',
	schema,
	...(description ? { description } : {}),
});

const idParam = (name: string, description: string) => ({ name, in: 'path', required: true, schema: { type: 'string' }, description });

const PAGING = [queryParam('limit', { type: 'integer', default: 20, maximum: 100 }), queryParam('offset', { type: 'integer', default: 0 })];

/**
 * 定義を組み立てる
 * 経路の網羅は`createRest`が登録したものと単体テストで突き合わせる, 片方だけ増えると生成物が実装とずれる
 */
export function openapiDocument(): OpenApiDocument {
	const paths: Record<string, Record<string, unknown>> = {
		'/api/jobs': {
			get: {
				operationId: 'listJobs',
				summary: 'List jobs',
				description:
					'Reads the D1 read model, which lags behind the coordinator by a few seconds. ' +
					'Filters combine with AND. Key filters match exactly; prefix and substring matching are not supported.',
				parameters: [
					queryParam('state', { type: 'string' }, 'Filter by job state'),
					queryParam('binding', { type: 'string' }, 'Filter by performer binding name'),
					queryParam('id', { type: 'string' }, 'Exact job id'),
					queryParam('unique_key', { type: 'string' }, 'Exact uniqueKey'),
					queryParam('concurrency_key', { type: 'string' }, 'Exact concurrencyKey'),
					queryParam('created_from', { type: 'integer' }, 'Lower bound of created_at, inclusive'),
					queryParam('created_to', { type: 'integer' }, 'Upper bound of created_at, inclusive'),
					queryParam(
						'sort',
						{ type: 'string', enum: [...SORTABLE_COLUMNS], default: 'updated_at' },
						'Unknown values fall back to the default instead of failing.',
					),
					queryParam('order', { type: 'string', enum: ['asc', 'desc'], default: 'desc' }),
					...PAGING,
				],
				responses: {
					200: {
						description: 'A page of jobs',
						...json({
							type: 'object',
							properties: { jobs: { type: 'array', items: ref('JobSummary') }, total: integer() },
							required: ['jobs', 'total'],
						}),
					},
					...RESPONSES.unauthorized,
					...RESPONSES.unavailable,
				},
			},
			post: {
				operationId: 'createJob',
				summary: 'Enqueue a job',
				requestBody: { required: true, ...json(ref('CreateJobRequest')) },
				responses: {
					201: {
						description: 'Enqueued. On a uniqueKey collision the id of the existing job is returned.',
						...json({ type: 'object', properties: { id: string() }, required: ['id'] }),
					},
					...badBody,
					...RESPONSES.unauthorized,
					...RESPONSES.notImplemented,
					...RESPONSES.unavailable,
				},
			},
		},
		'/api/jobs/{id}': {
			get: {
				operationId: 'getJob',
				summary: 'Get a job with its attempt log',
				parameters: [idParam('id', 'Job id')],
				responses: {
					200: {
						description: 'The job',
						...json({ type: 'object', properties: { job: ref('JobDetail') }, required: ['job'] }),
					},
					...RESPONSES.unauthorized,
					...RESPONSES.notFound,
					...RESPONSES.unavailable,
				},
			},
		},
		'/api/jobs/{id}/retry': {
			post: {
				operationId: 'retryJob',
				summary: 'Retry a failed job',
				description: 'Accepted for FAILED and STALLED jobs only.',
				parameters: [idParam('id', 'Job id')],
				responses: { ...RESPONSES.mutation, ...badJobId, ...RESPONSES.unauthorized, ...RESPONSES.unavailable },
			},
		},
		'/api/jobs/{id}/reschedule': {
			post: {
				operationId: 'rescheduleJob',
				summary: 'Change when a scheduled job runs',
				description: 'Accepted for SCHEDULED jobs only. The job id and any uniqueKey reservation are kept.',
				parameters: [idParam('id', 'Job id')],
				requestBody: { required: true, ...json(ref('RescheduleRequest')) },
				responses: { ...RESPONSES.mutation, ...badJobIdOrBody, ...RESPONSES.unauthorized, ...RESPONSES.unavailable },
			},
		},
		'/api/jobs/{id}/cancel': {
			post: {
				operationId: 'cancelJob',
				summary: 'Cancel a job that has not started',
				description: 'Accepted for SCHEDULED jobs only. From QUEUED onwards execution may already have begun.',
				parameters: [idParam('id', 'Job id')],
				responses: { ...RESPONSES.mutation, ...badJobId, ...RESPONSES.unauthorized, ...RESPONSES.unavailable },
			},
		},
		'/api/jobs/bulk-retry': {
			post: {
				operationId: 'bulkRetryJobs',
				summary: 'Retry several failed jobs',
				description: 'Accepts FAILED and STALLED jobs. Jobs in any other state are reported in failed.',
				requestBody: { required: true, ...json(ref('BulkRequest')) },
				responses: {
					200: { description: 'Processed, including partial refusals', ...json(ref('BulkResult')) },
					...badBody,
					...RESPONSES.unauthorized,
					...RESPONSES.unavailable,
				},
			},
		},
		'/api/jobs/bulk-cancel': {
			post: {
				operationId: 'bulkCancelJobs',
				summary: 'Cancel several jobs that have not started',
				description: 'Accepts SCHEDULED jobs. Jobs in any other state are reported in failed.',
				requestBody: { required: true, ...json(ref('BulkRequest')) },
				responses: {
					200: { description: 'Processed, including partial refusals', ...json(ref('BulkResult')) },
					...badBody,
					...RESPONSES.unauthorized,
					...RESPONSES.unavailable,
				},
			},
		},
		'/api/bindings': {
			get: {
				operationId: 'listBindings',
				summary: 'List registered performer bindings',
				responses: {
					200: {
						description: 'Binding names',
						...json({ type: 'object', properties: { bindings: { type: 'array', items: string() } }, required: ['bindings'] }),
					},
					...RESPONSES.unauthorized,
					...RESPONSES.unavailable,
				},
			},
		},
		'/api/stats': {
			get: {
				operationId: 'getStats',
				summary: 'Job counts per state',
				responses: {
					200: {
						description: 'Aggregates',
						...json({
							type: 'object',
							properties: {
								byState: { type: 'object', additionalProperties: integer() },
								oldestScheduledMs: { ...nullable('integer'), description: 'Age of the oldest scheduled job' },
							},
							required: ['byState', 'oldestScheduledMs'],
						}),
					},
					...RESPONSES.unauthorized,
					...RESPONSES.unavailable,
				},
			},
		},
		'/api/diagnostics': {
			get: {
				operationId: 'getDiagnostics',
				summary: 'Operational diagnostics per binding',
				description: 'Asks the coordinator directly rather than the read model, so the numbers are current.',
				responses: {
					200: {
						description: 'Diagnostics',
						...json({
							type: 'object',
							properties: { shard: integer(), bindings: { type: 'object', additionalProperties: ref('Diagnostics') } },
							required: ['shard', 'bindings'],
						}),
					},
					...RESPONSES.unauthorized,
					...RESPONSES.unavailable,
				},
			},
		},
		'/api/runs': {
			get: {
				operationId: 'listRuns',
				summary: 'List runs',
				parameters: [
					queryParam('state', { type: 'string' }, 'Filter by run state'),
					queryParam('flow', { type: 'string' }, 'Filter by flow name'),
					...PAGING,
				],
				responses: {
					200: {
						description: 'A page of runs',
						...json({
							type: 'object',
							properties: { runs: { type: 'array', items: ref('RunSummary') }, total: integer() },
							required: ['runs', 'total'],
						}),
					},
					...RESPONSES.unauthorized,
					...RESPONSES.unavailable,
				},
			},
			post: {
				operationId: 'startRun',
				summary: 'Start a run',
				requestBody: { required: true, ...json(ref('StartRunRequest')) },
				responses: {
					201: {
						description: 'Started. Starting twice with the same id returns the existing run id.',
						...json({ type: 'object', properties: { id: string() }, required: ['id'] }),
					},
					...badBody,
					...RESPONSES.unauthorized,
					...RESPONSES.notImplemented,
					...RESPONSES.unavailable,
				},
			},
		},
		'/api/runs/{id}': {
			get: {
				operationId: 'getRun',
				summary: 'Get a run with all of its nodes',
				parameters: [idParam('id', 'Run id')],
				responses: {
					200: {
						description: 'The run and its nodes',
						...json({
							type: 'object',
							properties: { run: ref('RunDetail'), nodes: { type: 'array', items: ref('RunNode') } },
							required: ['run', 'nodes'],
						}),
					},
					...RESPONSES.unauthorized,
					...RESPONSES.notFound,
					...RESPONSES.unavailable,
				},
			},
		},
		'/api/runs/{id}/retry': {
			post: {
				operationId: 'retryRun',
				summary: 'Resume a failed run from its failed nodes',
				parameters: [idParam('id', 'Run id')],
				responses: {
					...RESPONSES.mutation,
					...badRunId,
					...RESPONSES.unauthorized,
					...RESPONSES.notImplemented,
					...RESPONSES.unavailable,
				},
			},
		},
		'/api/runs/{id}/cancel': {
			post: {
				operationId: 'cancelRun',
				summary: 'Cancel a run',
				description: 'Stops nodes that have not started and waits for running jobs to reach a terminal state.',
				parameters: [idParam('id', 'Run id')],
				responses: {
					...RESPONSES.mutation,
					...badRunId,
					...RESPONSES.unauthorized,
					...RESPONSES.notImplemented,
					...RESPONSES.unavailable,
				},
			},
		},
		'/api/flows': {
			get: {
				operationId: 'listFlows',
				summary: 'List registered flows',
				responses: {
					200: {
						description: 'Flow names',
						...json({ type: 'object', properties: { flows: { type: 'array', items: string() } }, required: ['flows'] }),
					},
					...RESPONSES.unauthorized,
					...RESPONSES.unavailable,
				},
			},
		},
		'/api/openapi.json': {
			get: {
				operationId: 'getOpenApi',
				summary: 'This document',
				responses: {
					200: { description: 'The OpenAPI document', ...json({ type: 'object' }) },
					...RESPONSES.unauthorized,
				},
			},
		},
	};

	return {
		openapi: '3.1.0',
		info: {
			title: 'Tsumugi REST API',
			version: API_VERSION,
			description:
				'Management API of Tsumugi, a job management system built on the Cloudflare stack. ' +
				'Endpoints that depend on optional configuration answer 501 when that configuration is absent.',
		},
		paths,
		components: {
			schemas: SCHEMAS,
			// 認証は差し替え可能なので, 同梱の`bearerAuth`が受け付ける2つを並べる
			securitySchemes: {
				bearerAuth: { type: 'http', scheme: 'bearer', description: 'Authorization header.' },
				cookieAuth: {
					type: 'apiKey',
					in: 'cookie',
					name: 'tsumugi_token',
					description: 'Same token in a cookie. The cookie name is configured per deployment.',
				},
			},
		},
		// いずれか一方を満たせばよい, 別の認証を組んだ配備ではどちらも当てはまらない
		security: [{ bearerAuth: [] }, { cookieAuth: [] }],
	};
}
