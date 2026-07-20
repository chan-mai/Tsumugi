// examples/basicのMAIL_SERVICEに対応する補助Worker
// 相手不在ではworkerdが起動しないため,テスト側にも実体が要る
import { WorkerEntrypoint } from 'cloudflare:workers';

export class SendMail extends WorkerEntrypoint {
	async perform(payload, ctx) {
		// RPC境界を越える例外の伝播を見るための口
		if (payload?.fail) throw new Error('意図的な失敗');
		return { to: payload?.to ?? null, jobId: ctx?.jobId ?? null, keys: Object.keys(ctx ?? {}) };
	}
}

export default {
	async fetch() {
		return new Response('performer only', { status: 404 });
	},
};
