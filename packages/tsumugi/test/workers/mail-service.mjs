// examples/basicのMAILに対応する補助Worker
// 相手不在ではworkerdが起動せず、テスト側にも実体が必要
import { WorkerEntrypoint } from 'cloudflare:workers';

export class SendMail extends WorkerEntrypoint {
	async perform(payload, ctx) {
		if (payload?.log) await ctx.log(payload.log);
		// `fail`指定時はthrow, RPC経由の例外伝播の確認用
		if (payload?.fail) throw new Error('intentional failure');
		// `failWith`指定時は`ctx.fail`をRPC経由で呼び出してthrow(#91)
		if (payload?.failWith) {
			await ctx.fail(payload.failWith);
			throw new Error('intentional failure');
		}
		// `ctx.spawn`を呼び出し、関数がstubとして渡されたことを確認
		const spawned = typeof ctx?.spawn === 'function';
		if (spawned) await ctx.spawn('child', 'MAIL', { to: 'b@example.com' });
		return {
			to: payload?.to ?? null,
			jobId: ctx?.jobId ?? null,
			traceparent: ctx?.traceparent ?? null,
			keys: Object.keys(ctx ?? {}),
			spawned,
		};
	}
}

export default {
	async fetch() {
		return new Response('performer only', { status: 404 });
	},
};
