// examples/basicのMAILに対応する補助Worker
// 接続先不在ではworkerd起動不可、テスト側にも実体が必要
import { WorkerEntrypoint } from 'cloudflare:workers';

export class SendMail extends WorkerEntrypoint {
	async perform(payload, ctx) {
		if (payload?.log) await ctx.log(payload.log);
		if (payload?.fail) throw new Error('intentional failure');
		if (payload?.failWith) {
			await ctx.fail(payload.failWith);
			throw new Error('intentional failure');
		}
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
