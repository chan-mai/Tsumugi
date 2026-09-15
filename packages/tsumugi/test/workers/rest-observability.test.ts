import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { bearerAuth } from '../../src/api/auth.js';
import type { RestEnv } from '../../src/api/rest.js';
import type { JobDetailResponse, JobListResponse } from '../../src/api/types.js';
import { Performer } from '../../src/performer/entrypoint.js';
import { defineTsumugi } from '../../src/worker.js';

const T0 = 2_200_000_000_000;
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const OTHER_TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4737-00f067aa0ba902b8-00';
const BINDING = 'RESTTRACE';
const headers = { authorization: 'Bearer trace-test-token', 'content-type': 'application/json' };

class Noop extends Performer<unknown, void, {}, RestEnv> {
	async perform(): Promise<void> {}
}

const worker = defineTsumugi({ performers: { [BINDING]: Noop }, auth: bearerAuth('trace-test-token') });
const stub = () => env.JOB_SHARD.get(env.JOB_SHARD.idFromName(`${BINDING}#0`));

function request(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
	return worker.fetch!(
		new Request(`https://example.com${path}`, {
			method,
			headers: { ...headers, ...extraHeaders },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		}),
		env as RestEnv,
		{ waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
	);
}

async function enqueue(body: Record<string, unknown> = {}, extraHeaders: Record<string, string> = {}) {
	await runInDurableObject(stub(), (instance) => {
		(instance as any).clock = { now: () => T0 };
		(instance as any).env.TSUMUGI_QUEUE = { send: async () => {}, sendBatch: async () => {} };
	});
	const response = await request('POST', '/api/jobs', { binding: BINDING, payload: {}, ...body }, extraHeaders);
	expect(response.status).toBe(201);
	const { id } = await response.json<{ id: string }>();
	await runDurableObjectAlarm(stub());
	return id;
}

async function detail(id: string) {
	const response = await request('GET', `/api/jobs/${encodeURIComponent(id)}`);
	expect(response.status).toBe(200);
	return (await response.json<JobDetailResponse>()).job;
}

describe('RESTのトレースとログ', () => {
	it('本文で省略されたtraceparentをヘッダーから保存する', async () => {
		const id = await enqueue({}, { traceparent: TRACEPARENT });
		expect((await detail(id)).traceparent).toBe(TRACEPARENT);
	});

	it('本文のtraceparentをヘッダーより優先する', async () => {
		for (const header of [OTHER_TRACEPARENT, 'invalid']) {
			const id = await enqueue({ traceparent: TRACEPARENT }, { traceparent: header });
			expect((await detail(id)).traceparent).toBe(TRACEPARENT);
		}
	});

	it('不正な本文または使用されるヘッダーのtraceparentは400を返す', async () => {
		for (const traceparent of [null, 42, '', 'invalid', TRACEPARENT.toUpperCase()]) {
			const response = await request('POST', '/api/jobs', { binding: BINDING, payload: {}, traceparent }, { traceparent: TRACEPARENT });
			expect(response.status).toBe(400);
			expect((await response.json<{ error: string }>()).error).toContain('traceparent');
		}
		const response = await request('POST', '/api/jobs', { binding: BINDING, payload: {} }, { traceparent: 'invalid' });
		expect(response.status).toBe(400);
	});

	it('未設定の詳細はnullと空配列を返し一覧には追加しない', async () => {
		const id = await enqueue();
		expect(await detail(id)).toMatchObject({ traceparent: null, logs: [] });
		const response = await request('GET', `/api/jobs?binding=${BINDING}`);
		const { jobs } = await response.json<JobListResponse>();
		const job = jobs.find((item) => item.id === id);
		expect(job).toBeDefined();
		expect(job).not.toHaveProperty('traceparent');
		expect(job).not.toHaveProperty('logs');
	});

	it('QUEUEDとRUNNINGのログを投影し終端後も詳細で返す', async () => {
		const id = await enqueue({ traceparent: TRACEPARENT });
		const message = '<script>alert("test")</script>\n処理開始';
		expect(await stub().log(id, 1, message)).toBe(true);
		await runDurableObjectAlarm(stub());
		expect(await detail(id)).toMatchObject({
			state: 'QUEUED',
			logs: [{ attempt: 1, timestamp: T0, message }],
		});

		expect(await stub().claim(id)).toBe(true);
		await runInDurableObject(stub(), (instance) => {
			(instance as any).clock = { now: () => T0 + 1_000 };
		});
		expect(await stub().log(id, 1, '処理終了')).toBe(true);
		await runDurableObjectAlarm(stub());
		const running = await detail(id);
		expect(running.state).toBe('RUNNING');
		expect(running.logs).toEqual([
			{ attempt: 1, timestamp: T0, message },
			{ attempt: 1, timestamp: T0 + 1_000, message: '処理終了' },
		]);

		await stub().report(id, { ok: true });
		await runDurableObjectAlarm(stub());
		expect(await detail(id)).toMatchObject({ state: 'COMPLETED', traceparent: TRACEPARENT, logs: running.logs });
	});

	it('不正なログJSONが保存されていても詳細を返す', async () => {
		const id = await enqueue();
		await env.TSUMUGI_DB.prepare('UPDATE job SET logs = ? WHERE id = ?').bind('{', id).run();
		expect((await detail(id)).logs).toEqual([]);
	});
});
