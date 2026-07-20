import { RemotePerformer, type RemoteJobContext } from 'tsumugi/performer';

/**
 * ジョブ管理Workerとは別Workerのperformer
 * 呼び出し側はservice bindingとして参照,登録簿には`remote('MAIL_SERVICE')`(ADR-0026)
 */
export class SendMail extends RemotePerformer<{ to: string; subject: string }, void, {}, Env> {
	async perform(payload: { to: string; subject: string }, ctx: RemoteJobContext): Promise<void> {
		// ctxに`signal`なし, RPCの引数はAbortSignal非対応で中断の依頼は届かない
		console.log(`send mail to ${payload.to} (${ctx.jobId}, attempt ${ctx.attempt})`);
	}
}

// WorkerEntrypointの名前付きexportに加えdefaultも必須
export default {
	async fetch(): Promise<Response> {
		return new Response('performer only', { status: 404 });
	},
} satisfies ExportedHandler<Env>;
