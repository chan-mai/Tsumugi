import { bearerAuth, createFlow, defineTsumugi, remote } from 'tsumugi';
import { ui } from 'tsumugi/ui';
import type { SendMail } from '../../remote-performer/src/index.js';
import * as local from './performers/index.js';

// performerは`ctx.exports`から引かれるので, トップレベルでexportする(ADR-0037)
export * from './performers/index.js';

// binding名はexportした名前, MAILだけ別Workerなので型のためにremote()を置く(ADR-0026)
const performers = { ...local, MAIL: remote<SendMail>() };

// flowの定義口をperformersから作る, bindingもpayloadもここから型が決まる(ADR-0030)
const flow = createFlow(performers);

// 一覧を取り, 件数だけ実行時に決まる並列で挨拶し, 最後に要約を書く
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
	// 子のrunとしてGREETINGSを起動し, その終端を待ってから要約する
	PIPELINE: flow<{ prefix: string }>((f) => {
		const greetings = f.subflow('greetings', GREETINGS, { input: (i) => ({ prefix: i.prefix }) });
		f.node('summary', 'Report', { after: { greetings }, input: () => ({ total: 1, failed: 0 }) });
	}),
};

// performersからbindingごとのpayload型とEnvを推論する, 明示の型引数は要らない(ADR-0010)
const tsumugi = defineTsumugi({
	performers,
	flows,
	// secretから引く,直書きするとリポジトリとバンドルの両方に残る
	auth: bearerAuth((env: Env) => env.TSUMUGI_TOKEN, { cookie: 'tsumugi_token' }),
	ui: ui({ tokenCookie: 'tsumugi_token' }),
	// Analytics Engineを読むにはアカウントのAPIトークンが要る, secretから引く
	metrics: (env: Env) =>
		env.CF_ACCOUNT_ID && env.CF_API_TOKEN
			? { accountId: env.CF_ACCOUNT_ID, apiToken: env.CF_API_TOKEN, dataset: 'tsumugi_jobs' }
			: undefined,
});

export { TsumugiJobShard } from 'tsumugi';
// flow定義を参照するクラスなのでパッケージからはエクスポートできない(ADR-0030)
// クラス宣言にするのは`wrangler types`が型として参照できるようにするため
export class TsumugiRun extends tsumugi.runClass {}

export default {
	...tsumugi,
	async fetch(request, env, ctx) {
		const { pathname } = new URL(request.url);
		if (pathname === '/enqueue') {
			// bindingからpayloadの型が決まる, 取り違えはコンパイルエラー(ADR-0010)
			const id = await tsumugi.enqueue(env, { binding: 'Hello', payload: { name: 'world' } });
			return Response.json({ id });
		}
		if (pathname === '/enqueue-mail') {
			const id = await tsumugi.enqueue(env, { binding: 'MAIL', payload: { to: 'a@example.com', subject: 'hi' } });
			return Response.json({ id });
		}
		if (pathname === '/start') {
			// flowからinputの型が決まる, idを渡せば二重開始を弾ける(ADR-0029)
			const id = await tsumugi.start(env, 'GREETINGS', { prefix: 'hello' });
			return Response.json({ id });
		}
		return tsumugi.fetch!(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
