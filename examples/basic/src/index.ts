import { bearerAuth, createFlow, defineTsumugi, remote } from 'tsumugi';
import { ui } from 'tsumugi/ui';
import { Performer } from 'tsumugi/performer';

class Hello extends Performer<{ name: string }, void, {}, Env> {
	async perform(payload: { name: string }): Promise<void> {
		console.log(`hello, ${payload.name}`);
	}
}

/** リトライとバックオフを見るための必ず失敗するperformer */
class Boom extends Performer<unknown, void, {}, Env> {
	async perform(): Promise<void> {
		throw new Error('意図的な失敗');
	}
}

/** DAGの前段, 戻り値が後段のpayloadの材料になる */
class ListNames extends Performer<{ prefix: string }, { names: string[] }, {}, Env> {
	async perform(payload: { prefix: string }) {
		return { names: [`${payload.prefix}-1`, `${payload.prefix}-2`, `${payload.prefix}-3`] };
	}
}

class Greet extends Performer<{ name: string }, { greeted: string }, {}, Env> {
	async perform(payload: { name: string }) {
		return { greeted: payload.name };
	}
}

class Report extends Performer<{ total: number; failed: number }, void, {}, Env> {
	async perform(payload: { total: number; failed: number }): Promise<void> {
		console.log(`greeted ${payload.total - payload.failed}/${payload.total}`);
	}
}

// binding名とperformerの対応はここ1箇所だけ
// MAILはservice binding越しの別Worker,同一の`performers`に混在可(ADR-0026)
const performers = { HELLO: Hello, BOOM: Boom, LIST: ListNames, GREET: Greet, REPORT: Report, MAIL: remote('MAIL_SERVICE') };

// flowの定義口をperformersから作る, bindingもpayloadもここから型が決まる(ADR-0030)
const flow = createFlow(performers);

const flows = {
	// 一覧を取り, 件数だけ実行時に決まる並列で挨拶し, 最後に要約を書く
	GREETINGS: flow<{ prefix: string }>((f) => {
		const list = f.node('list', 'LIST', { input: (i) => ({ prefix: i.prefix }) });
		const each = f.fanOut('greet', 'GREET', {
			after: { list },
			over: (_i, d) => d.list.names,
			input: (name) => ({ name }),
		});
		f.node('report', 'REPORT', {
			after: { each },
			input: (_i, d) => ({ total: d.each.total, failed: d.each.failed }),
		});
	}),
};

// performersからbindingごとのpayload型とEnvを推論する, 明示の型引数は要らない(ADR-0010)
const tsumugi = defineTsumugi({
	performers,
	flows,
	// secretから引く,直書きするとリポジトリとバンドルの両方に残る
	auth: bearerAuth((env: Env) => env.TSUMUGI_TOKEN, { cookie: 'tsumugi_token' }),
	ui: ui({ tokenCookie: 'tsumugi_token' }),
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
			const id = await tsumugi.enqueue(env, { binding: 'HELLO', payload: { name: 'world' } });
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
