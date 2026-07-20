import { Hono } from 'hono';
import { InvalidJobIdError, shardNameOf } from '../core/ids.js';
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

/**
 * 一覧と詳細はD1の読み取りモデルから引く(ADR-0008)
 * 稼働中も投影済みなのでページングもソートも通常のSQL
 */
export function createRest<Env extends RestEnv>(auth: AuthMiddleware, options: RestOptions<Env> = {}): Hono<{ Bindings: Env }> {
	const { dashboard, bindings = [], enqueue } = options;
	const app = new Hono<{ Bindings: Env }>();
	// 認証はAPIにのみ掛ける
	// HTMLの殻はデータを含まず,未認証で返すことでSPAがトークン入力を出せる(ADR-0013)
	app.use('/api/*', auth);

	app.get('/api/jobs', async (c) => {
		const url = new URL(c.req.url);
		const state = url.searchParams.get('state');
		const binding = url.searchParams.get('binding');
		const limit = Math.min(Number(url.searchParams.get('limit') ?? 20) || 20, LIST_LIMIT_MAX);
		const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0);

		const where: string[] = [];
		const args: unknown[] = [];
		if (state) {
			where.push('state = ?');
			args.push(state);
		}
		if (binding) {
			where.push('binding = ?');
			args.push(binding);
		}
		const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

		const [page, total] = await c.env.TSUMUGI_DB.batch<Record<string, unknown>>([
			c.env.TSUMUGI_DB.prepare(
				`SELECT id, binding, state, priority, attempts, max_attempts, created_at, updated_at, dispatched_at
				 FROM job ${clause} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
			).bind(...args, limit, offset),
			c.env.TSUMUGI_DB.prepare(`SELECT COUNT(*) AS total FROM job ${clause}`).bind(...args),
		]);

		return c.json({ jobs: page?.results ?? [], total: (total?.results?.[0]?.total as number) ?? 0 });
	});

	/**
	 * フィルタと投入先の選択肢
	 * 登録済みperformerを返す,投影済みのbindingだけだと一度も動いていないものが選べない
	 */
	app.get('/api/bindings', async (c) => {
		if (bindings.length > 0) return c.json({ bindings: [...bindings].sort() });
		const { results } = await c.env.TSUMUGI_DB.prepare(`SELECT DISTINCT binding FROM job ORDER BY binding`).all<{ binding: string }>();
		return c.json({ bindings: results.map((row) => row.binding) });
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
		const { results } = await c.env.TSUMUGI_DB.prepare(`SELECT state, COUNT(*) AS count FROM job GROUP BY state`).all<{
			state: string;
			count: number;
		}>();
		return c.json({ byState: Object.fromEntries(results.map((r) => [r.state, r.count])) });
	});

	app.get('/api/jobs/:id', async (c) => {
		const job = await c.env.TSUMUGI_DB.prepare(`SELECT * FROM job WHERE id = ?`).bind(c.req.param('id')).first();
		if (!job) return c.json({ error: 'not found' }, 404);
		return c.json({ job });
	});

	app.post('/api/jobs/:id/retry', async (c) => {
		const id = c.req.param('id');
		try {
			// 変更は真実の源であるDOへ問い合わせる
			const ok = await stubOf(c.env, id).retry(id);
			return c.json({ ok }, ok ? 200 : 409);
		} catch (error) {
			if (error instanceof InvalidJobIdError) return c.json({ error: 'invalid job id' }, 400);
			throw error;
		}
	});

	app.post('/api/jobs/:id/cancel', async (c) => {
		const id = c.req.param('id');
		try {
			const ok = await stubOf(c.env, id).cancel(id);
			// SCHEDULED以外は取り消し不可(ADR-0012)
			return c.json({ ok }, ok ? 200 : 409);
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
