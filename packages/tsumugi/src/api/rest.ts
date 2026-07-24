import { and, asc, desc as sqlDesc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { cachedCheck, migrationErrorMessage } from '../projection/migrations.js';
import { job as readModel } from '../projection/tables.js';
import { InvalidJobIdError, shardName, shardNameOf } from '../core/ids.js';
import type { TsumugiJobShard } from '../do/job-shard.js';
import type { ConsumerEnv } from '../queue/consumer.js';
import type { Ui } from '../ui/serve.js';
import type { AuthMiddleware } from './auth.js';

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
	 * 一覧に`retryable`を載せるために要る, 押すまで分からないボタンを出さないため(ADR-0027)
	 */
	failedRetentionMs?: (binding: string) => number;
};

export type CreateJobInput = {
	binding: string;
	payload: unknown;
	maxAttempts?: number;
	delayMs?: number;
	priority?: number;
	concurrencyKey?: string;
	uniqueKey?: string;
};

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
export function attemptsOf(job: Record<string, unknown>, stored: AttemptRecord[]): AttemptRecord[] {
	if (stored.length > 0) return stored;
	if (job.state !== 'COMPLETED' || job.dispatched_at === null || job.dispatched_at === undefined) return [];
	return [
		{
			attempt: Number(job.attempts) || 1,
			state: 'COMPLETED',
			started_at: Number(job.dispatched_at),
			finished_at: Number(job.updated_at),
			error: null,
		},
	];
}

export type AttemptRecord = {
	attempt: number;
	state: string;
	started_at: number | null;
	finished_at: number;
	error: string | null;
};

/**
 * 並べ替えを許す列
 * 列オブジェクトへ解決してから使うので, 許可リスト外の文字列がSQLに届かない
 */
const SORT_COLUMNS = {
	updated_at: readModel.updatedAt,
	created_at: readModel.createdAt,
	binding: readModel.binding,
	state: readModel.state,
	priority: readModel.priority,
	attempts: readModel.attempts,
} as const;

export const SORTABLE_COLUMNS = Object.keys(SORT_COLUMNS) as (keyof typeof SORT_COLUMNS)[];
export type SortColumn = keyof typeof SORT_COLUMNS;

/** 不正な指定は既定へ,エラー化するとUIが止まる */
export function resolveSort(sort: string | null, order: string | null): { column: SortColumn; desc: boolean } {
	// `in`はプロトタイプ鎖まで見るので`constructor`等が素通りし,列の代わりに関数が渡る
	const column = sort !== null && Object.hasOwn(SORT_COLUMNS, sort) ? (sort as SortColumn) : 'updated_at';
	return { column, desc: order !== 'asc' };
}

/**
 * 一覧と詳細はD1の読み取りモデルから引く(ADR-0008)
 * 稼働中も投影済みなのでページングもソートも通常のSQL
 */
export function createRest<Env extends RestEnv>(auth: AuthMiddleware, options: RestOptions<Env> = {}): Hono<{ Bindings: Env }> {
	const { dashboard, bindings = [], enqueue, failedRetentionMs } = options;

	/**
	 * 一覧の1行にretryの可否を載せる
	 * 読み取りモデルはDOに行が在るかを知らないので保持期間から引き算する
	 * 実際の可否はDOが持つため410が最終的な答え, ここは押す前に分かるようにするための近似
	 */
	const withRetryable = (row: Record<string, unknown>, now: number) => {
		const retryableState = row.state === 'FAILED' || row.state === 'STALLED';
		if (!retryableState) return { ...row, retryable: false };
		if (!failedRetentionMs) return { ...row, retryable: true };
		const keepFor = failedRetentionMs(String(row.binding));
		return { ...row, retryable: Number(row.updated_at) > now - keepFor };
	};
	const app = new Hono<{ Bindings: Env }>();
	// 認証はAPIにのみ掛ける
	// HTMLの殻はデータを含まず,未認証で返すことでSPAがトークン入力を出せる(ADR-0013)
	app.use('/api/*', auth);

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
		const limit = Math.min(Number(url.searchParams.get('limit') ?? 20) || 20, LIST_LIMIT_MAX);
		const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0);
		const { column, desc } = resolveSort(url.searchParams.get('sort'), url.searchParams.get('order'));

		const d = drizzle(c.env.TSUMUGI_DB);
		const filters = [state ? eq(readModel.state, state) : undefined, binding ? eq(readModel.binding, binding) : undefined].filter(
			(f) => f !== undefined,
		);
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
		return c.json({
			jobs: page.map((row) => withRetryable(row as Record<string, unknown>, now)),
			total: total[0]?.total ?? 0,
		});
	});

	/**
	 * フィルタと投入先の選択肢
	 * 登録済みperformerを返す,投影済みのbindingだけだと一度も動いていないものが選べない
	 */
	app.get('/api/bindings', async (c) => {
		if (bindings.length > 0) return c.json({ bindings: [...bindings].sort() });
		const rows = await drizzle(c.env.TSUMUGI_DB)
			.selectDistinct({ binding: readModel.binding })
			.from(readModel)
			.orderBy(asc(readModel.binding));
		return c.json({ bindings: rows.map((row) => row.binding) });
	});

	app.post('/api/jobs', async (c) => {
		if (!enqueue) return c.json({ error: 'job creation is not available' }, 501);

		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: 'body must be valid JSON' }, 400);
		}

		const parsed = validateCreateJob(body, bindings);
		if ('error' in parsed) return c.json({ error: parsed.error }, 400);

		const id = await enqueue(c.env, parsed.input);
		return c.json({ id }, 201);
	});

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
		return c.json({
			byState: Object.fromEntries(rows.map((r) => [r.state, r.count])),
			oldestScheduledMs: oldestCreatedAt === null ? null : Math.max(0, Date.now() - oldestCreatedAt),
		});
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
		return c.json({ shard: 0, bindings: Object.fromEntries(perBinding) });
	});

	app.get('/api/jobs/:id', async (c) => {
		const rows = await drizzle(c.env.TSUMUGI_DB)
			.select()
			.from(readModel)
			.where(eq(readModel.id, c.req.param('id')))
			.limit(1);
		const found = rows[0];
		if (!found) return c.json({ error: 'not found' }, 404);

		// 返す列を明示する, 展開すると投影の内部列(seq)やcamelCaseの重複まで出る
		const job: Record<string, unknown> = {
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
			payload: found.payload,
			// performの戻り値, 成功時のみ入り未完了はnull(#9), payloadと同じくJSON文字列のまま返す
			result: found.result,
		};
		// 履歴は詳細でだけ返す, 一覧に載せると1画面で数百KBになり得る(ADR-0028)
		// `attempts`は試行回数の数値なので別名にする, 潰すと画面の n/m が壊れる
		return c.json({ job: { ...withRetryable(job, Date.now()), attempts_log: attemptsOf(job, parseAttempts(found.attemptsLog)) } });
	});

	/**
	 * 断られた理由をHTTPの意味に写す
	 * goneは410, 資源が在ったが失われた状態を指す, 状態違いの409とは利用者の打つ手が違う
	 */
	function refusal(result: { ok: false; reason: 'invalid-state' | 'gone' }) {
		return result.reason === 'gone'
			? ({
					body: { ok: false, error: 'job is no longer available: removed from the coordinator after the retention period' },
					status: 410,
				} as const)
			: ({ body: { ok: false, error: 'not allowed in the current state' }, status: 409 } as const);
	}

	app.post('/api/jobs/:id/retry', async (c) => {
		const id = c.req.param('id');
		try {
			// 変更は正となるDOへ問い合わせる
			const result = await stubOf(c.env, id).retry(id);
			if (result.ok) return c.json({ ok: true }, 200);
			const { body, status } = refusal(result);
			return c.json(body, status);
		} catch (error) {
			if (error instanceof InvalidJobIdError) return c.json({ error: 'invalid job id' }, 400);
			throw error;
		}
	});

	app.post('/api/jobs/:id/cancel', async (c) => {
		const id = c.req.param('id');
		try {
			// SCHEDULED以外は取り消し不可(ADR-0012)
			const result = await stubOf(c.env, id).cancel(id);
			if (result.ok) return c.json({ ok: true }, 200);
			const { body, status } = refusal(result);
			return c.json(body, status);
		} catch (error) {
			if (error instanceof InvalidJobIdError) return c.json({ error: 'invalid job id' }, 400);
			throw error;
		}
	});

	// APIに該当しないGETはSPAへ渡す,クライアント側でルーティングする
	if (dashboard) {
		app.get('*', (c) => c.html(dashboard.render()));
	}

	return app;
}
