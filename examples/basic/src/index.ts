import { bearerAuth, createFlow, defineTsumugi, remote } from 'tsumugi';
import { ui } from 'tsumugi/ui';
import type { SendMail } from '../../remote-performer/src/index.js';
import * as local from './performers/index.js';

// performerはトップレベルからexportする, export名がそのままbinding名になる
export * from './performers/index.js';

// MAILだけ別Workerのperformer, 型を渡すためにremote()を置く
const performers = { ...local, MAIL: remote<SendMail>() };

const flow = createFlow(performers);

// 一覧を取得し, 件数が実行時に決まる並列処理を挟んで要約する
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
	// GREETINGSを子のRunとして起動し, 完了を待ってから要約する
	PIPELINE: flow<{ prefix: string }>((f) => {
		const greetings = f.subflow('greetings', GREETINGS, { input: (i) => ({ prefix: i.prefix }) });
		f.node('summary', 'Report', { after: { greetings }, input: () => ({ total: 1, failed: 0 }) });
	}),
	// Run全体の期限付き, 超過するとFAILEDになる
	TIMED: flow<{ prefix: string }>(
		(f) => {
			f.node('list', 'ListNames', { input: (i) => ({ prefix: i.prefix }) });
		},
		{ deadlineMs: 10 * 60 * 1000 },
	),
	// 失敗時の後始末と入力による経路の選択
	BRANCHED: flow<{ prefix: string; verbose: boolean }>((f) => {
		const list = f.node('list', 'ListNames', { input: (i) => ({ prefix: i.prefix }) });
		// 依存が失敗した場合だけ実行する
		f.node('cleanup', 'Report', { after: { list }, trigger: 'failure', input: () => ({ total: 0, failed: 1 }) });
		// falseを返すとSKIPPEDになり下流も実行されない
		f.node('detail', 'Report', {
			after: { list },
			when: (i, d) => i.verbose && d.list.names.length > 0,
			input: (_i, d) => ({ total: d.list.names.length, failed: 0 }),
		});
		// 依存の成否に関わらず実行する
		f.node('audit', 'Report', { after: { list }, trigger: 'always', input: () => ({ total: 1, failed: 0 }) });
	}),
};

// payloadの型もEnvもperformersから決まるので型引数の指定は不要
const tsumugi = defineTsumugi({
	performers,
	flows,
	onFailure: 'NotifyFailure',
	schedules: {
		// 固定間隔, 前回が終わっていなければ発火しない
		'poll-names': { binding: 'ListNames', payload: { prefix: 'poll' }, everyMs: 5 * 60 * 1000 },
		// 前回の終了を待たずに発火する
		'ping-hello': { binding: 'Hello', payload: { name: 'ping' }, everyMs: 60_000, overlap: 'overlap' },
		// cronはUTCの分精度, 引数は発火の予定時刻
		nightly: { flow: 'GREETINGS', input: ({ scheduledAt }) => ({ prefix: `nightly-${scheduledAt}` }), cron: '0 3 * * *' },
	},
	// トークンはsecretから取得する, 直書きするとリポジトリとバンドルの両方に残る
	auth: bearerAuth((env: Env) => env.TSUMUGI_TOKEN, { cookie: 'tsumugi_token' }),
	ui: ui({ tokenCookie: 'tsumugi_token' }),
	// メトリクスの取得にはアカウントのAPIトークンが必要
	metrics: (env: Env) =>
		env.CF_ACCOUNT_ID && env.CF_API_TOKEN
			? { accountId: env.CF_ACCOUNT_ID, apiToken: env.CF_API_TOKEN, dataset: 'tsumugi_jobs' }
			: undefined,
});

export { TsumugiJobShard } from 'tsumugi';
// flowsを使う場合はこのクラスもexportしてwranglerに登録する
export class TsumugiRun extends tsumugi.runClass {}
// schedulesを使う場合はこのクラスもexportしてwranglerに登録する
export class TsumugiScheduler extends tsumugi.schedulerClass {}

export default {
	...tsumugi,
	async fetch(request, env, ctx) {
		const { pathname } = new URL(request.url);
		if (pathname === '/enqueue') {
			// payloadの型はbindingから決まる, 取り違えはコンパイルエラー
			const id = await tsumugi.enqueue(env, { binding: 'Hello', payload: { name: 'world' } });
			return Response.json({ id });
		}
		if (pathname === '/enqueue-mail') {
			const id = await tsumugi.enqueue(env, { binding: 'MAIL', payload: { to: 'a@example.com', subject: 'hi' } });
			return Response.json({ id });
		}
		if (pathname === '/start') {
			// inputの型はFlowの定義から決まる
			const id = await tsumugi.start(env, 'GREETINGS', { prefix: 'hello' });
			return Response.json({ id });
		}
		// 残りはダッシュボードとREST APIへ
		return tsumugi.fetch!(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
