import { bearerAuth, defineTsumugi, enqueue } from 'tsumugi';
import { ui } from 'tsumugi/ui';
import { Performer } from 'tsumugi/performer';

class Hello extends Performer<{ name: string }, void, {}, Env> {
	async perform(payload: { name: string }): Promise<void> {
		console.log(`hello, ${payload.name}`);
	}
}

// binding名とperformerの対応はここ1箇所だけ
const performers = { HELLO: Hello };

const tsumugi = defineTsumugi<Env>({
	performers,
	auth: bearerAuth('dev-token', { cookie: 'tsumugi_token' }),
	ui: ui({ tokenCookie: 'tsumugi_token' }),
});

export { TsumugiJobShard } from 'tsumugi';

export default {
	...tsumugi,
	async fetch(request, env, ctx) {
		if (new URL(request.url).pathname === '/enqueue') {
			const id = await enqueue(env, { binding: 'HELLO', payload: { name: 'world' } });
			return Response.json({ id });
		}
		return tsumugi.fetch!(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
