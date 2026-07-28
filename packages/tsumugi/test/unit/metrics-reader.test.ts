import { describe, expect, it } from 'vitest';
import { bindingSql, MetricsQueryError, parseMetricsQuery, readMetrics, seriesSql } from '../../src/analytics/reader.js';

const config = { accountId: 'acct', apiToken: 'token', dataset: 'tsumugi_jobs' };
const parse = (query: string) => parseMetricsQuery(new URL(`https://example.test/api/metrics${query}`));

/** SQL APIの応答を差し替える, 送ったSQLも記録する */
function stub(responses: unknown[], status = 200) {
	const sent: string[] = [];
	let at = 0;
	const impl = (async (_url: string, init: RequestInit) => {
		sent.push(String(init.body));
		const body = responses[at++] ?? { data: [] };
		return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	}) as unknown as typeof globalThis.fetch;
	return { sent, impl };
}

describe('集計の区間と絞り込み', () => {
	it('既定は24時間', () => {
		expect(parse('')).toEqual({ query: { hours: 24 } });
	});

	it('指定した区間を使う', () => {
		expect(parse('?hours=168')).toEqual({ query: { hours: 168 } });
	});

	it('範囲外の区間を拒否する', () => {
		expect(parse('?hours=0')).toEqual({ error: 'hours must be at least 1' });
		expect(parse('?hours=721')).toEqual({ error: 'hours must not exceed 720' });
		expect(parse('?hours=day')).toEqual({ error: 'hours must be at least 1' });
	});

	it('binding名として成立しない値を拒否する', () => {
		// SQLへ直接差し込むので, 入口で文字を絞る
		for (const binding of ["MAIL' OR '1'='1", 'MAIL;DROP', '1MAIL', 'MA IL']) {
			expect(parse(`?binding=${encodeURIComponent(binding)}`), binding).toEqual({ error: 'binding is not a valid name' });
		}
		expect(parse('?binding=MAIL_2')).toEqual({ query: { hours: 24, binding: 'MAIL_2' } });
	});
});

describe('組み立てるSQL', () => {
	it('件数をサンプリングの重みで数える', () => {
		// 素のcount()だとサンプリングが効いた時点で実件数と乖離する
		const sql = bindingSql({ hours: 24 }, 'tsumugi_jobs');
		expect(sql).toContain('sum(_sample_interval) AS total');
		expect(sql).toContain('quantileWeighted(0.95)(double2, _sample_interval)');
	});

	it('所要時間の平均も重みを掛ける', () => {
		expect(bindingSql({ hours: 24 }, 'tsumugi_jobs')).toContain('sum(double2 * _sample_interval) / sum(_sample_interval)');
	});

	it('失敗はFAILEDとSTALLEDで数える', () => {
		expect(bindingSql({ hours: 24 }, 'tsumugi_jobs')).toContain("blob1 IN ('FAILED', 'STALLED')");
	});

	it('区間と絞り込みを条件に載せる', () => {
		const sql = bindingSql({ hours: 72, binding: 'MAIL' }, 'tsumugi_jobs');
		expect(sql).toContain("INTERVAL '72' HOUR");
		expect(sql).toContain("blob2 = 'MAIL'");
	});

	it('推移は1時間ごとにまとめる', () => {
		expect(seriesSql({ hours: 24 }, 'tsumugi_jobs')).toContain("toStartOfInterval(timestamp, INTERVAL '1' HOUR)");
	});

	it('書き出し先を指定どおりに使う', () => {
		expect(bindingSql({ hours: 24 }, 'custom_dataset')).toContain('FROM custom_dataset');
	});
});

describe('応答の読み取り', () => {
	it('失敗率を件数から出す', async () => {
		const { impl } = stub([
			{
				data: [
					{
						binding: 'MAIL',
						total: '10',
						failed: '2',
						avg_duration: '1500',
						max_duration: '4000',
						p95_duration: '3000',
						avg_attempts: '1.2',
					},
				],
			},
			{ data: [] },
		]);

		const result = await readMetrics(config, { hours: 24 }, impl);
		expect(result.bindings[0]).toEqual({
			binding: 'MAIL',
			total: 10,
			failed: 2,
			failureRate: 0.2,
			avgDurationMs: 1500,
			maxDurationMs: 4000,
			p95DurationMs: 3000,
			avgAttempts: 1.2,
		});
	});

	it('件数が0でも失敗率を0にする', async () => {
		const { impl } = stub([{ data: [{ binding: 'MAIL', total: '0', failed: '0' }] }, { data: [] }]);
		expect((await readMetrics(config, { hours: 24 }, impl)).bindings[0]?.failureRate).toBe(0);
	});

	it('時刻をepochミリ秒へ直す', async () => {
		const { impl } = stub([{ data: [] }, { data: [{ at: '2026-07-26 09:00:00', total: '3', failed: '1', avg_duration: '900' }] }]);
		const result = await readMetrics(config, { hours: 24 }, impl);
		expect(result.series[0]?.at).toBe(Date.parse('2026-07-26T09:00:00Z'));
	});

	it('2xx以外は理由を持つ例外にする', async () => {
		const impl = (async () => new Response('token is missing required permission', { status: 403 })) as unknown as typeof globalThis.fetch;
		await expect(readMetrics(config, { hours: 24 }, impl)).rejects.toThrow(MetricsQueryError);
		await expect(readMetrics(config, { hours: 24 }, impl)).rejects.toMatchObject({ status: 403 });
	});

	it('アカウントIDとトークンを要求に載せる', async () => {
		const sent: { url: string; init: RequestInit }[] = [];
		const impl = (async (url: string, init: RequestInit) => {
			sent.push({ url, init });
			return new Response('{"data":[]}', { status: 200 });
		}) as unknown as typeof globalThis.fetch;

		await readMetrics(config, { hours: 24 }, impl);
		expect(sent[0]?.url).toBe('https://api.cloudflare.com/client/v4/accounts/acct/analytics_engine/sql');
		expect((sent[0]?.init.headers as Record<string, string>).authorization).toBe('Bearer token');
	});
});
