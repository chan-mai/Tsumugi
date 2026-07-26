import { and, asc, desc as sqlDesc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { cachedCheck, migrationErrorMessage } from '../projection/migrations.js';
import { job as readModel } from '../projection/tables.js';
import { run as runModel, runNode } from '../projection/run-tables.js';
import { InvalidJobIdError, InvalidRunIdError, parseRunId, shardName, shardNameOf } from '../core/ids.js';
import type { BulkFailure, MutationResult, TsumugiJobShard } from '../do/job-shard.js';
import type { ConsumerEnv } from '../queue/consumer.js';
import type { Ui } from '../ui/serve.js';
import type { AuthMiddleware } from './auth.js';
import { openapiDocument } from './openapi.js';
import { resolveSort, SORTABLE_COLUMNS, type SortColumn } from './sort.js';
import type {
	AttemptRecord,
	BindingsResponse,
	CreateJobRequest,
	CreateJobResponse,
	DiagnosticsResponse,
	ErrorResponse,
	FlowsResponse,
	JobDetail,
	JobDetailResponse,
	JobListResponse,
	JobSummary,
	MutationResponse,
	RunDetailResponse,
	RunListResponse,
	StartRunRequest,
	StartRunResponse,
	StatsResponse,
} from './types.js';

export type RestEnv = ConsumerEnv & { TSUMUGI_DB: D1Database };

const LIST_LIMIT_MAX = 100;

function stubOf(env: RestEnv, jobId: string): DurableObjectStub<TsumugiJobShard> {
	return env.JOB_SHARD.get(env.JOB_SHARD.idFromName(shardNameOf(jobId)));
}

export type RestOptions<Env extends RestEnv> = {
	dashboard?: Ui;
	/** 登録済みperformerの名前,投入先の検証と選択肢に使う */
	bindings?: readonly string[];
	enqueue?: (env: Env, input: CreateJobInput) => Promise<string>;
	/**
	 * bindingごとの失敗ジョブの保持期間
	 * 一覧に`retryable`を含めるために必要, 実行可否を事前に判定するため(ADR-0027)
	 */
	failedRetentionMs?: (binding: string) => number;
	/** 登録済みflowの名前,開始先の検証と選択肢に使う */
	flows?: readonly string[];
	start?: (env: Env, flow: string, input: unknown, id?: string) => Promise<string>;
	/** 取り消しと再開はDOへ直接送る, 読み取りモデルは正の根拠に使えない(ADR-0015) */
	runFor?: (env: Env, runId: string) => { cancel(): Promise<MutationResult>; retry(): Promise<MutationResult> };
};

/** 要求と応答の型は`api/types.ts`が持つ, 外部の利用者と同じ定義を読む */
export type CreateJobInput = CreateJobRequest;

/** 投入内容の検証,通らなければ理由を返す */
export function validateCreateJob(body: unknown, bindings: readonly string[]): { input: CreateJobInput } | { error: string } {
	if (typeof body !== 'object' || body === null) return { error: 'body must be an object' };
	const raw = body as Record<string, unknown>;

	if (typeof raw.binding !== 'string' || raw.binding.length === 0) return { error: 'binding is required' };
	// 未登録のbindingを許すと投入はできるが実行時に必ず失敗する,入口で弾く
	if (bindings.length > 0 && !bindings.includes(raw.binding)) return { error: `unknown binding: ${raw.binding}` };
	if (!('payload' in raw)) return { error: 'payload is required' };

	const numbers: [keyof CreateJobInput, unknown][] = [
		['maxAttempts', raw.maxAttempts],
		['delayMs', raw.delayMs],
		['priority', raw.priority],
	];
	for (const [name, value] of numbers) {
		if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) return { error: `${name} must be a number` };
	}
	if (typeof raw.maxAttempts === 'number' && raw.maxAttempts < 1) return { error: 'maxAttempts must be at least 1' };
	if (typeof raw.delayMs === 'number' && raw.delayMs < 0) return { error: 'delayMs must not be negative' };

	for (const name of ['concurrencyKey', 'uniqueKey'] as const) {
		if (raw[name] !== undefined && typeof raw[name] !== 'string') return { error: `${name} must be a string` };
	}

	const input: CreateJobInput = { binding: raw.binding, payload: raw.payload };
	if (typeof raw.maxAttempts === 'number') input.maxAttempts = raw.maxAttempts;
	if (typeof raw.delayMs === 'number') input.delayMs = raw.delayMs;
	if (typeof raw.priority === 'number') input.priority = raw.priority;
	if (typeof raw.concurrencyKey === 'string' && raw.concurrencyKey) input.concurrencyKey = raw.concurrencyKey;
	if (typeof raw.uniqueKey === 'string' && raw.uniqueKey) input.uniqueKey = raw.uniqueKey;
	return { input };
}

export type RescheduleInput = { runAfter: number; priority?: number };

/**
 * 実行時刻の変更内容の検証,通らなければ理由を返す
 * `runAt`と`delayMs`は排他、両方指定された場合にどちらを優先するかは決めない
 */
export function validateReschedule(body: unknown, now: number): { input: RescheduleInput } | { error: string } {
	if (typeof body !== 'object' || body === null) return { error: 'body must be an object' };
	const raw = body as Record<string, unknown>;

	const numbers: [string, unknown][] = [
		['runAt', raw.runAt],
		['delayMs', raw.delayMs],
		['priority', raw.priority],
	];
	for (const [name, value] of numbers) {
		if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) return { error: `${name} must be a number` };
	}

	const hasRunAt = typeof raw.runAt === 'number';
	const hasDelay = typeof raw.delayMs === 'number';
	if (hasRunAt && hasDelay) return { error: 'runAt and delayMs are mutually exclusive' };
	if (!hasRunAt && !hasDelay) return { error: 'runAt or delayMs is required' };
	if (hasDelay && (raw.delayMs as number) < 0) return { error: 'delayMs must not be negative' };

	const runAfter = hasRunAt ? (raw.runAt as number) : now + (raw.delayMs as number);
	return { input: { runAfter, ...(typeof raw.priority === 'number' ? { priority: raw.priority } : {}) } };
}

export type StartRunInput = StartRunRequest;

/** 開始内容の検証,通らなければ理由を返す */
export function validateStartRun(body: unknown, flows: readonly string[]): { input: StartRunInput } | { error: string } {
	if (typeof body !== 'object' || body === null) return { error: 'body must be an object' };
	const raw = body as Record<string, unknown>;

	if (typeof raw.flow !== 'string' || raw.flow.length === 0) return { error: 'flow is required' };
	// 未登録のflowを許すと開始はできるが必ず失敗する,入口で弾く
	if (flows.length > 0 && !flows.includes(raw.flow)) return { error: `unknown flow: ${raw.flow}` };
	if (!('input' in raw)) return { error: 'input is required' };
	if (raw.id !== undefined && typeof raw.id !== 'string') return { error: 'id must be a string' };

	const input: StartRunInput = { flow: raw.flow, input: raw.input };
	if (typeof raw.id === 'string' && raw.id) input.id = raw.id;
	return { input };
}

/**
 * 一括操作が1回で扱う件数の上限
 * DOのtickが1回で扱う上限と揃える、超えた分は呼び出し側が繰り返して処理する
 */
export const BULK_LIMIT_MAX = 200;

/**
 * 一括操作の対象になる状態
 * 個別のretry / cancelが受け付ける状態と同じ、ここを広げるとDO側で断られるだけの要求が増える
 */
export const BULK_STATES = {
	retry: ['FAILED', 'STALLED'],
	cancel: ['SCHEDULED'],
} as const;

/**
 * 一括操作の対象
 * 画面はIDを列挙し、一覧に出ない件数を扱う利用者は条件を渡す
 */
export type BulkTarget =
	| { kind: 'ids'; ids: string[] }
	| {
			kind: 'filter';
			binding?: string;
			/** 未指定なら操作が受け付ける状態すべてを対象にする */
			states: readonly string[];
			uniqueKey?: string;
			concurrencyKey?: string;
			createdFrom?: number;
			createdTo?: number;
			limit: number;
	  };

/**
 * 一括操作の対象の検証、通らなければ理由を返す
 *
 * `ids`があればそれだけを対象にする、条件との併用は対象が二通りに読める
 * 条件で指定する場合の状態は操作が受け付けるものに限る、限らないと対象が減らず繰り返しが終わらない
 */
export function validateBulk(body: unknown, action: 'retry' | 'cancel'): { input: BulkTarget } | { error: string } {
	if (typeof body !== 'object' || body === null) return { error: 'body must be an object' };
	const raw = body as Record<string, unknown>;
	const allowed: readonly string[] = BULK_STATES[action];

	if (raw.ids !== undefined) {
		if (!Array.isArray(raw.ids)) return { error: 'ids must be an array' };
		if (raw.ids.length === 0) return { error: 'ids must not be empty' };
		if (raw.ids.length > BULK_LIMIT_MAX) return { error: `ids must not exceed ${BULK_LIMIT_MAX} entries` };
		if (raw.ids.some((id) => typeof id !== 'string' || id.length === 0)) return { error: 'ids must be non-empty strings' };
		return { input: { kind: 'ids', ids: raw.ids as string[] } };
	}

	for (const name of ['binding', 'state', 'unique_key', 'concurrency_key'] as const) {
		if (raw[name] !== undefined && typeof raw[name] !== 'string') return { error: `${name} must be a string` };
	}
	if (typeof raw.state === 'string' && !allowed.includes(raw.state)) {
		return { error: `state must be one of ${allowed.join(', ')} for ${action}` };
	}

	for (const name of ['created_from', 'created_to', 'limit'] as const) {
		if (raw[name] !== undefined && (typeof raw[name] !== 'number' || !Number.isFinite(raw[name]))) {
			return { error: `${name} must be a number` };
		}
	}
	if (typeof raw.limit === 'number' && raw.limit < 1) return { error: 'limit must be at least 1' };

	return {
		input: {
			kind: 'filter',
			states: typeof raw.state === 'string' ? [raw.state] : allowed,
			limit: Math.min(typeof raw.limit === 'number' ? raw.limit : BULK_LIMIT_MAX, BULK_LIMIT_MAX),
			...(typeof raw.binding === 'string' && raw.binding ? { binding: raw.binding } : {}),
			...(typeof raw.unique_key === 'string' && raw.unique_key ? { uniqueKey: raw.unique_key } : {}),
			...(typeof raw.concurrency_key === 'string' && raw.concurrency_key ? { concurrencyKey: raw.concurrency_key } : {}),
			...(typeof raw.created_from === 'number' ? { createdFrom: raw.created_from } : {}),
			...(typeof raw.created_to === 'number' ? { createdTo: raw.created_to } : {}),
		},
	};
}

/** ジョブIDをshardごとにまとめる、1件ずつ送るとDOへの往復が件数だけ増える */
export function groupByShard(jobIds: readonly string[]): { groups: Map<string, string[]>; invalid: string[] } {
	const groups = new Map<string, string[]>();
	const invalid: string[] = [];

	for (const jobId of jobIds) {
		let name: string;
		try {
			name = shardNameOf(jobId);
		} catch {
			// 読み取りモデルの行が壊れている場合は落とさず理由に載せる
			invalid.push(jobId);
			continue;
		}
		const bucket = groups.get(name);
		if (bucket) bucket.push(jobId);
		else groups.set(name, [jobId]);
	}
	return { groups, invalid };
}

/** 一覧のページング, 上限の変更漏れを避けるため両方の一覧で共有する */
export function parsePaging(url: URL): { limit: number; offset: number } {
	return {
		limit: Math.min(Number(url.searchParams.get('limit') ?? 20) || 20, LIST_LIMIT_MAX),
		offset: Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0),
	};
}

export type JobFilters = {
	id?: string;
	uniqueKey?: string;
	concurrencyKey?: string;
	/** created_atの下限と上限, いずれも両端を含む */
	createdFrom?: number;
	createdTo?: number;
};

/**
 * 一覧の絞り込み条件
 * 数値にならない指定は無視する, 400にすると入力の途中で画面が止まる
 * 一致は完全一致のみ, 部分一致は索引が効かず件数が増えると全表走査になる
 */
export function parseJobFilters(url: URL): JobFilters {
	const text = (name: string) => url.searchParams.get(name) || undefined;
	const time = (name: string) => {
		const raw = url.searchParams.get(name);
		// 空文字は指定なしとして扱う, Number('')は0になり期間の上限が1970年になる
		if (raw === null || raw === '') return undefined;
		const value = Number(raw);
		return Number.isFinite(value) ? value : undefined;
	};

	return {
		...(text('id') ? { id: text('id') as string } : {}),
		...(text('unique_key') ? { uniqueKey: text('unique_key') as string } : {}),
		...(text('concurrency_key') ? { concurrencyKey: text('concurrency_key') as string } : {}),
		...(time('created_from') !== undefined ? { createdFrom: time('created_from') as number } : {}),
		...(time('created_to') !== undefined ? { createdTo: time('created_to') as number } : {}),
	};
}

/** 依存のノードID, 壊れた行で詳細画面ごと落とさない */
export function parseAfter(raw: unknown): string[] {
	if (typeof raw !== 'string' || raw.length === 0) return [];
	try {
		const parsed = JSON.parse(raw) as string[];
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/** 試行履歴, 壊れていても詳細画面ごと落とさない */
export function parseAttempts(raw: unknown): AttemptRecord[] {
	if (typeof raw !== 'string' || raw.length === 0) return [];
	try {
		const parsed = JSON.parse(raw) as AttemptRecord[];
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/**
 * 1回目で成功したジョブの履歴を組み立てる
 *
 * この1件はジョブ行から完全に導出できるので保存していない(ADR-0028)
 * 表示のためだけに書くと1ジョブあたりのDO書き込みが常時1回増える
 * 導出できるのはCOMPLETEDかつ開始時刻がある場合に限る,実行中や取り消しでは何も出さない
 */
export function attemptsOf(
	job: { state: string; attempts: number; dispatched_at: number | null; updated_at: number },
	stored: AttemptRecord[],
): AttemptRecord[] {
	if (stored.length > 0) return stored;
	if (job.state !== 'COMPLETED' || job.dispatched_at === null) return [];
	return [
		{
			attempt: job.attempts || 1,
			state: 'COMPLETED',
			started_at: job.dispatched_at,
			finished_at: job.updated_at,
			error: null,
		},
	];
}

export type { AttemptRecord };

/**
 * 並べ替えを許す列の対応
 * 列オブジェクトへ解決してから使うので, 許可リスト外の文字列がSQLに届かない
 * `satisfies`で全列を網羅させる, 名前を足して対応を忘れると型検査で落ちる
 */
const SORT_COLUMNS = {
	updated_at: readModel.updatedAt,
	created_at: readModel.createdAt,
	binding: readModel.binding,
	state: readModel.state,
	priority: readModel.priority,
	attempts: readModel.attempts,
} satisfies Record<SortColumn, unknown>;

export { resolveSort, SORTABLE_COLUMNS };
export type { SortColumn };

/**
 * 一覧と詳細はD1の読み取りモデルから引く(ADR-0008)
 * 稼働中も投影済みなのでページングもソートも通常のSQL
 */
export function createRest<Env extends RestEnv>(auth: AuthMiddleware, options: RestOptions<Env> = {}): Hono<{ Bindings: Env }> {
	const { dashboard, bindings = [], enqueue, failedRetentionMs, flows = [], start, runFor } = options;

	/**
	 * 一覧の1行にretryの可否を載せる
	 * 読み取りモデルはDOに行が在るかを知らないので保持期間から引き算する
	 * 実際の可否はDOが持つため410が最終的な答え, ここは押す前に分かるようにするための近似
	 */
	const withRetryable = <T extends { state: string; binding: string; updated_at: number }>(
		row: T,
		now: number,
	): T & { retryable: boolean } => {
		const retryableState = row.state === 'FAILED' || row.state === 'STALLED';
		if (!retryableState) return { ...row, retryable: false };
		if (!failedRetentionMs) return { ...row, retryable: true };
		const keepFor = failedRetentionMs(row.binding);
		return { ...row, retryable: row.updated_at > now - keepFor };
	};
	const app = new Hono<{ Bindings: Env }>();
	// 認証はAPIにのみ掛ける
	// HTML自体はデータを含まず, 未認証で返すことでSPAがトークン入力欄を表示できる(ADR-0013)
	app.use('/api/*', auth);

	// 仕様の配布口, 他言語の利用者はここからクライアントを生成する
	// D1を読まないのでマイグレーションの検査より手前に置く, 後ろだと適用漏れの環境で仕様も引けない
	const document = openapiDocument();
	app.get('/api/openapi.json', (c) => c.json(document));

	// マイグレーションの適用漏れをここで止める
	// 通さないとD1のraw errorが出るだけで,原因が設定漏れだと分からない
	const checkSchema = cachedCheck();
	app.use('/api/*', async (c, next) => {
		const status = await checkSchema(c.env.TSUMUGI_DB);
		if (!status.ok) {
			// 適用漏れは復旧コマンドを, 一時障害は適用済み環境に誤った手順を案内しない(#8)
			const error = 'missing' in status ? migrationErrorMessage(status.missing) : 'database temporarily unavailable';
			return c.json({ error }, 503);
		}
		await next();
	});

	app.get('/api/jobs', async (c) => {
		const url = new URL(c.req.url);
		const state = url.searchParams.get('state');
		const binding = url.searchParams.get('binding');
		const { limit, offset } = parsePaging(url);
		const { column, desc } = resolveSort(url.searchParams.get('sort'), url.searchParams.get('order'));
		const { id, uniqueKey, concurrencyKey, createdFrom, createdTo } = parseJobFilters(url);

		const d = drizzle(c.env.TSUMUGI_DB);
		const filters = [
			state ? eq(readModel.state, state) : undefined,
			binding ? eq(readModel.binding, binding) : undefined,
			id ? eq(readModel.id, id) : undefined,
			uniqueKey ? eq(readModel.uniqueKey, uniqueKey) : undefined,
			concurrencyKey ? eq(readModel.concurrencyKey, concurrencyKey) : undefined,
			createdFrom !== undefined ? gte(readModel.createdAt, createdFrom) : undefined,
			createdTo !== undefined ? lte(readModel.createdAt, createdTo) : undefined,
		].filter((f) => f !== undefined);
		const clause = filters.length > 0 ? and(...filters) : undefined;
		const sortBy = SORT_COLUMNS[column];

		// idの副次キーで同値時の順序を固定
		const [page, total] = await d.batch([
			d
				.select({
					id: readModel.id,
					binding: readModel.binding,
					state: readModel.state,
					priority: readModel.priority,
					attempts: readModel.attempts,
					max_attempts: readModel.maxAttempts,
					created_at: readModel.createdAt,
					updated_at: readModel.updatedAt,
					dispatched_at: readModel.dispatchedAt,
				})
				.from(readModel)
				.where(clause)
				.orderBy(desc ? sqlDesc(sortBy) : asc(sortBy), sqlDesc(readModel.id))
				.limit(limit)
				.offset(offset),
			d
				.select({ total: sql<number>`count(*)` })
				.from(readModel)
				.where(clause),
		]);

		const now = Date.now();
		const body: JobListResponse = {
			jobs: page.map((row) => withRetryable(row, now) satisfies JobSummary),
			total: total[0]?.total ?? 0,
		};
		return c.json(body);
	});

	/**
	 * フィルタと投入先の選択肢
	 * 登録済みperformerを返す,投影済みのbindingだけだと一度も動いていないものが選べない
	 */
	app.get('/api/bindings', async (c) => {
		if (bindings.length > 0) return c.json({ bindings: [...bindings].sort() } satisfies BindingsResponse);
		const rows = await drizzle(c.env.TSUMUGI_DB)
			.selectDistinct({ binding: readModel.binding })
			.from(readModel)
			.orderBy(asc(readModel.binding));
		return c.json({ bindings: rows.map((row) => row.binding) } satisfies BindingsResponse);
	});

	app.post('/api/jobs', async (c) => {
		if (!enqueue) return c.json({ error: 'job creation is not available' } satisfies ErrorResponse, 501);

		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: 'body must be valid JSON' } satisfies ErrorResponse, 400);
		}

		const parsed = validateCreateJob(body, bindings);
		if ('error' in parsed) return c.json({ error: parsed.error } satisfies ErrorResponse, 400);

		const id = await enqueue(c.env, parsed.input);
		return c.json({ id } satisfies CreateJobResponse, 201);
	});

	/**
	 * 条件に一致するジョブをまとめて処理する
	 *
	 * 対象は読み取りモデルから引く、横断的な絞り込みはDOには問い合わせられない(ADR-0008)
	 * 数秒遅れるので状態の判定はDO側で改めて行い、条件に合わないものは理由付きで返す
	 * 一部が断られても全体を失敗にしない、失敗にすると成功した分まで再送される
	 */
	const bulk = async (action: 'retry' | 'cancel', env: Env, body: unknown) => {
		const parsed = validateBulk(body, action);
		if ('error' in parsed) return { body: { error: parsed.error }, status: 400 } as const;
		const target = parsed.input;

		let targets: string[];
		let remaining = 0;
		if (target.kind === 'ids') {
			targets = target.ids;
		} else {
			const { states, limit, binding, uniqueKey, concurrencyKey, createdFrom, createdTo } = target;
			const d = drizzle(env.TSUMUGI_DB);
			const clause = and(
				...[
					inArray(readModel.state, [...states]),
					binding ? eq(readModel.binding, binding) : undefined,
					uniqueKey ? eq(readModel.uniqueKey, uniqueKey) : undefined,
					concurrencyKey ? eq(readModel.concurrencyKey, concurrencyKey) : undefined,
					createdFrom !== undefined ? gte(readModel.createdAt, createdFrom) : undefined,
					createdTo !== undefined ? lte(readModel.createdAt, createdTo) : undefined,
				].filter((f) => f !== undefined),
			);

			// 古い順に処理する、繰り返し呼んだときに対象が順に減る
			const [page, total] = await d.batch([
				d.select({ id: readModel.id }).from(readModel).where(clause).orderBy(asc(readModel.createdAt), asc(readModel.id)).limit(limit),
				d
					.select({ total: sql<number>`count(*)` })
					.from(readModel)
					.where(clause),
			]);
			targets = page.map((row) => row.id);
			// 上限で切った残り、読み取りモデルの遅れを含むので見積り
			remaining = Math.max(0, (total[0]?.total ?? 0) - targets.length);
		}

		const { groups, invalid } = groupByShard(targets);
		const results = await Promise.all(
			[...groups].map(([name, ids]) => env.JOB_SHARD.get(env.JOB_SHARD.idFromName(name)).mutateMany(action, ids)),
		);

		const failed: (BulkFailure | { id: string; reason: 'invalid-id' })[] = [
			...results.flatMap((result) => result.failed),
			...invalid.map((id) => ({ id, reason: 'invalid-id' as const })),
		];
		return { body: { ok: results.flatMap((result) => result.ok), failed, remaining }, status: 200 } as const;
	};

	for (const action of ['retry', 'cancel'] as const) {
		app.post(`/api/jobs/bulk-${action}`, async (c) => {
			let body: unknown;
			try {
				body = await c.req.json();
			} catch {
				return c.json({ error: 'body must be valid JSON' }, 400);
			}
			const { body: result, status } = await bulk(action, c.env, body);
			return c.json(result, status);
		});
	}

	app.get('/api/stats', async (c) => {
		const db = drizzle(c.env.TSUMUGI_DB);
		const rows = await db
			.select({ state: readModel.state, count: sql<number>`count(*)` })
			.from(readModel)
			.groupBy(readModel.state);
		// 最古のSCHEDULEDの経過時間, バックログがどれだけ待たされているかの指標(#10)
		// 読み取りモデル経由なので数秒遅れる, 傾向を掴む用途
		const oldest = await db
			.select({ createdAt: sql<number | null>`min(${readModel.createdAt})` })
			.from(readModel)
			.where(eq(readModel.state, 'SCHEDULED'));
		const oldestCreatedAt = oldest[0]?.createdAt ?? null;
		const body: StatsResponse = {
			byState: Object.fromEntries(rows.map((r) => [r.state, r.count])),
			oldestScheduledMs: oldestCreatedAt === null ? null : Math.max(0, Date.now() - oldestCreatedAt),
		};
		return c.json(body);
	});

	// 運用診断, DOに直接問い合わせてバックログ/投影滞留/投入が止まった制約を返す(#10)
	// 既定はshards=1なのでshard 0を代表として引く, 分割時はshard 0のみになる(ADR-0011)
	app.get('/api/diagnostics', async (c) => {
		const perBinding = await Promise.all(
			bindings.map(async (binding) => {
				const stub = c.env.JOB_SHARD.get(c.env.JOB_SHARD.idFromName(shardName(binding, 0)));
				return [binding, await stub.diagnostics()] as const;
			}),
		);
		const body: DiagnosticsResponse = { shard: 0, bindings: Object.fromEntries(perBinding) };
		return c.json(body);
	});

	app.get('/api/jobs/:id', async (c) => {
		const rows = await drizzle(c.env.TSUMUGI_DB)
			.select()
			.from(readModel)
			.where(eq(readModel.id, c.req.param('id')))
			.limit(1);
		const found = rows[0];
		if (!found) return c.json({ error: 'not found' } satisfies ErrorResponse, 404);

		// 返す列を明示する, 展開すると投影の内部列(seq)やcamelCaseの重複まで出る
		const job: Omit<JobDetail, 'retryable' | 'attempts_log'> = {
			id: found.id,
			binding: found.binding,
			state: found.state,
			priority: found.priority,
			attempts: found.attempts,
			max_attempts: found.maxAttempts,
			concurrency_key: found.concurrencyKey,
			unique_key: found.uniqueKey,
			guarantee: found.guarantee,
			created_at: found.createdAt,
			updated_at: found.updatedAt,
			dispatched_at: found.dispatchedAt,
			// SCHEDULEDが実行可能になる時刻, 変更できるので現在値を返す
			run_after: found.runAfter,
			payload: found.payload,
			// performの戻り値, 成功時のみ入り未完了はnull(#9), payloadと同じくJSON文字列のまま返す
			result: found.result,
		};
		// 履歴は詳細でだけ返す, 一覧に載せると1画面で数百KBになり得る(ADR-0028)
		// `attempts`は試行回数の数値なので別名にする, 上書きすると画面の n/m が壊れる
		const detail: JobDetail = { ...withRetryable(job, Date.now()), attempts_log: attemptsOf(job, parseAttempts(found.attemptsLog)) };
		return c.json({ job: detail } satisfies JobDetailResponse);
	});

	/**
	 * 断られた理由をHTTPの意味に写す
	 * goneは410, 資源が在ったが失われた状態を指す, 状態違いの409とは利用者の打つ手が違う
	 */
	function refusal(result: { ok: false; reason: 'invalid-state' | 'gone' }, subject: 'job' | 'run' = 'job') {
		return result.reason === 'gone'
			? ({
					body: { ok: false, error: `${subject} is no longer available: removed from the coordinator after the retention period` },
					status: 410,
				} as const)
			: ({ body: { ok: false, error: 'not allowed in the current state' }, status: 409 } as const);
	}

	app.post('/api/jobs/:id/retry', async (c) => {
		const id = c.req.param('id');
		try {
			// 変更は正となるDOへ問い合わせる
			const result = await stubOf(c.env, id).retry(id);
			if (result.ok) return c.json({ ok: true } satisfies MutationResponse, 200);
			const { body, status } = refusal(result);
			return c.json(body, status);
		} catch (error) {
			if (error instanceof InvalidJobIdError) return c.json({ error: 'invalid job id' } satisfies ErrorResponse, 400);
			throw error;
		}
	});

	app.post('/api/jobs/:id/reschedule', async (c) => {
		const id = c.req.param('id');

		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: 'body must be valid JSON' } satisfies ErrorResponse, 400);
		}

		const parsed = validateReschedule(body, Date.now());
		if ('error' in parsed) return c.json({ error: parsed.error } satisfies ErrorResponse, 400);

		try {
			// SCHEDULED以外は予定を変えても実行が止まらないのでDO側で断る
			const result = await stubOf(c.env, id).reschedule(id, parsed.input);
			if (result.ok) return c.json({ ok: true } satisfies MutationResponse, 200);
			const { body: refused, status } = refusal(result);
			return c.json(refused, status);
		} catch (error) {
			if (error instanceof InvalidJobIdError) return c.json({ error: 'invalid job id' } satisfies ErrorResponse, 400);
			throw error;
		}
	});

	app.post('/api/jobs/:id/cancel', async (c) => {
		const id = c.req.param('id');
		try {
			// SCHEDULED以外は取り消し不可(ADR-0012)
			const result = await stubOf(c.env, id).cancel(id);
			if (result.ok) return c.json({ ok: true } satisfies MutationResponse, 200);
			const { body, status } = refusal(result);
			return c.json(body, status);
		} catch (error) {
			if (error instanceof InvalidJobIdError) return c.json({ error: 'invalid job id' } satisfies ErrorResponse, 400);
			throw error;
		}
	});

	/**
	 * runの一覧(ADR-0029)
	 * Run DOはrunごとに独立しているので, 横断的な一覧は読み取りモデルからしか引けない
	 */
	app.get('/api/runs', async (c) => {
		const url = new URL(c.req.url);
		const state = url.searchParams.get('state');
		const flow = url.searchParams.get('flow');
		const { limit, offset } = parsePaging(url);

		const d = drizzle(c.env.TSUMUGI_DB);
		const filters = [state ? eq(runModel.state, state) : undefined, flow ? eq(runModel.flow, flow) : undefined].filter(
			(f) => f !== undefined,
		);
		const clause = filters.length > 0 ? and(...filters) : undefined;

		const [page, total] = await d.batch([
			d
				.select({
					id: runModel.id,
					flow: runModel.flow,
					state: runModel.state,
					node_total: runModel.nodeTotal,
					node_done: runModel.nodeDone,
					node_failed: runModel.nodeFailed,
					created_at: runModel.createdAt,
					updated_at: runModel.updatedAt,
				})
				.from(runModel)
				.where(clause)
				.orderBy(sqlDesc(runModel.updatedAt), sqlDesc(runModel.id))
				.limit(limit)
				.offset(offset),
			d
				.select({ total: sql<number>`count(*)` })
				.from(runModel)
				.where(clause),
		]);

		const body: RunListResponse = { runs: page, total: total[0]?.total ?? 0 };
		return c.json(body);
	});

	/** 開始先の選択肢, 一度も実行されていないflowも選べるよう`flows`から返す */
	app.get('/api/flows', (c) => c.json({ flows: [...flows].sort() } satisfies FlowsResponse));

	app.post('/api/runs', async (c) => {
		if (!start) return c.json({ error: 'run creation is not available' } satisfies ErrorResponse, 501);

		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: 'body must be valid JSON' } satisfies ErrorResponse, 400);
		}

		const parsed = validateStartRun(body, flows);
		if ('error' in parsed) return c.json({ error: parsed.error } satisfies ErrorResponse, 400);

		const id = await start(c.env, parsed.input.flow, parsed.input.input, parsed.input.id);
		return c.json({ id } satisfies StartRunResponse, 201);
	});

	// グラフは1回のクエリで返す, 段組みの描画に全ノードが必要
	app.get('/api/runs/:id', async (c) => {
		const id = c.req.param('id');
		const d = drizzle(c.env.TSUMUGI_DB);
		const [runs, nodes] = await d.batch([
			d.select().from(runModel).where(eq(runModel.id, id)).limit(1),
			d.select().from(runNode).where(eq(runNode.runId, id)).orderBy(asc(runNode.position)),
		]);

		const found = runs[0];
		if (!found) return c.json({ error: 'not found' } satisfies ErrorResponse, 404);
		const body: RunDetailResponse = {
			run: {
				id: found.id,
				flow: found.flow,
				state: found.state,
				input: found.input,
				node_total: found.nodeTotal,
				node_done: found.nodeDone,
				node_failed: found.nodeFailed,
				created_at: found.createdAt,
				updated_at: found.updatedAt,
				// subflowとして起動された場合の親, 画面から親のrunへ辿る
				parent_run_id: found.parentRunId,
				parent_node_id: found.parentNodeId,
				// 終端でなければ再開できない, 押す前に可否を出す(ADR-0034)
				retryable: found.state === 'FAILED',
			},
			nodes: nodes.map((node) => ({
				id: node.nodeId,
				binding: node.binding,
				state: node.state,
				container: node.container === 1,
				parent: node.parent,
				origin: node.origin,
				after: parseAfter(node.after),
				job_id: node.jobId,
				child_run_id: node.childRunId,
				result: node.result,
				error: node.error,
				position: node.position,
				created_at: node.createdAt,
				updated_at: node.updatedAt,
			})),
		};
		return c.json(body);
	});

	/**
	 * 取り消しと再開は正となるRun DOへ送る
	 * Honoの文脈型に依存しないよう, 必要な値だけを引数で受ける
	 */
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

	// APIに該当しないGETはSPAへ渡す,クライアント側でルーティングする
	if (dashboard) {
		app.get('*', (c) => c.html(dashboard.render()));
	}

	return app;
}
