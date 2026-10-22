import { bearerAuth, createFlow, defineTsumugi, remote } from 'tsumugi';
import { ui } from 'tsumugi/ui';
import type { SendMail } from '../../remote-performer/src/index.js';
import * as local from './performers/index.js';

// performerはトップレベルからexport必須
export * from './performers/index.js';

const performers = { ...local, MAIL: remote<SendMail>() };

const flow = createFlow(performers);

const GREETINGS = flow<{ prefix: string }>((f) => {
	const list = f.node('list', 'ListNames', { input: (i) => ({ prefix: i.prefix }) });
	const each = f.fanOut('greet', 'Greet', {
		after: { list },
		over: (_i, d) => d.list.names,
		input: (name) => ({ name }),
	});
	f.node('report', 'Report', {
		after: { each },
		input: (_i, d) => ({ total: d.each.total, failed: d.each.failed }),
	});
});

const flows = {
	GREETINGS,
	PIPELINE: flow<{ prefix: string }>((f) => {
		const greetings = f.subflow('greetings', GREETINGS, { input: (i) => ({ prefix: i.prefix }) });
		f.node('summary', 'Report', { after: { greetings }, input: () => ({ total: 1, failed: 0 }) });
	}),
	TIMED: flow<{ prefix: string }>(
		(f) => {
			f.node('list', 'ListNames', { input: (i) => ({ prefix: i.prefix }) });
		},
		{ deadlineMs: 10 * 60 * 1000 },
	),
	BRANCHED: flow<{ prefix: string; verbose: boolean }>((f) => {
		const list = f.node('list', 'ListNames', { input: (i) => ({ prefix: i.prefix }) });
		f.node('cleanup', 'Report', { after: { list }, trigger: 'failure', input: () => ({ total: 0, failed: 1 }) });
		f.node('detail', 'Report', {
			after: { list },
			when: (i, d) => i.verbose && d.list.names.length > 0,
			input: (_i, d) => ({ total: d.list.names.length, failed: 0 }),
		});
		f.node('audit', 'Report', { after: { list }, trigger: 'always', input: () => ({ total: 1, failed: 0 }) });
	}),
};

const tsumugi = defineTsumugi({
	performers,
	flows,
	onFailure: 'NotifyFailure',
	// statesは明示必須
	onSettled: { binding: 'NotifySettled', states: ['FAILED', 'CANCELLED', 'STALLED'] },
	onEnqueue: (input) => (input.binding === 'ListNames' ? { timeoutMs: 45_000 } : undefined),
	schedules: {
		// 前回未完了なら発火なし
		'poll-names': { binding: 'ListNames', payload: { prefix: 'poll' }, everyMs: 5 * 60 * 1000 },
		'ping-hello': { binding: 'Hello', payload: { name: 'ping' }, everyMs: 60_000, overlap: 'overlap' },
		nightly: {
			flow: 'GREETINGS',
			input: ({ scheduledAt }) => ({ prefix: `nightly-${scheduledAt}` }),
			cron: '0 3 * * *',
			timeZone: 'Asia/Tokyo',
		},
	},
	// 直書きはリポジトリ, バンドルに残存
	auth: bearerAuth((env: Env) => env.TSUMUGI_TOKEN, { cookie: 'tsumugi_token' }),
	ui: ui({ tokenCookie: 'tsumugi_token' }),
	metrics: (env: Env) =>
		env.CF_ACCOUNT_ID && env.CF_API_TOKEN
			? { accountId: env.CF_ACCOUNT_ID, apiToken: env.CF_API_TOKEN, dataset: 'tsumugi_jobs' }
			: undefined,
});

export { TsumugiJobShard } from 'tsumugi';
// flows利用時はexport, wrangler登録が必要
export class TsumugiRun extends tsumugi.runClass {}
// schedules利用時はexport, wrangler登録が必要
export class TsumugiScheduler extends tsumugi.schedulerClass {}

export default {
	...tsumugi,
	async fetch(request, env, ctx) {
		const { pathname } = new URL(request.url);
		if (pathname === '/enqueue') {
			const id = await tsumugi.enqueue(env, { binding: 'Hello', payload: { name: 'world' } });
			return Response.json({ id });
		}
		if (pathname === '/enqueue-mail') {
			const id = await tsumugi.enqueue(env, { binding: 'MAIL', payload: { to: 'a@example.com', subject: 'hi' } });
			return Response.json({ id });
		}
		if (pathname === '/start') {
			const id = await tsumugi.start(env, 'GREETINGS', { prefix: 'hello' });
			return Response.json({ id });
		}
		return tsumugi.fetch!(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
