import { bearerAuth, defineTsumugi, enqueue, remote } from 'tsumugi';
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

// binding名とperformerの対応はここ1箇所だけ
// MAILはservice binding越しの別Worker,同一の登録簿に混在可(ADR-0026)
const performers = { HELLO: Hello, BOOM: Boom, MAIL: remote('MAIL_SERVICE') };

const tsumugi = defineTsumugi<Env>({
	performers,
	// secretから引く,直書きするとリポジトリとバンドルの両方に残る
	auth: bearerAuth((env: Env) => env.TSUMUGI_TOKEN, { cookie: 'tsumugi_token' }),
	ui: ui({ tokenCookie: 'tsumugi_token' }),
});

export { TsumugiJobShard } from 'tsumugi';

export default {
	...tsumugi,
	async fetch(request, env, ctx) {
		const { pathname } = new URL(request.url);
		if (pathname === '/enqueue') {
			const id = await enqueue(env, { binding: 'HELLO', payload: { name: 'world' } });
			return Response.json({ id });
		}
		if (pathname === '/enqueue-mail') {
			const id = await enqueue(env, { binding: 'MAIL', payload: { to: 'a@example.com', subject: 'hi' } });
			return Response.json({ id });
		}
		return tsumugi.fetch!(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
