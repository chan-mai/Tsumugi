import { Performer, type JobContext } from 'tsumugi/performer';

/**
 * ジョブ管理Workerとは別Workerのperformer
 * 同一Workerに置く場合と書き方は変わらない, 呼び出し側がservice bindingで参照する(ADR-0026)
 */
export class SendMail extends Performer<{ to: string; subject: string }, void, {}, Env> {
	async perform(payload: { to: string; subject: string }, ctx: JobContext): Promise<void> {
		console.log(`send mail to ${payload.to} (${ctx.jobId}, attempt ${ctx.attempt})`);
	}
}

// WorkerEntrypointの名前付きexportに加えdefaultも必須
export default {
	async fetch(): Promise<Response> {
		return new Response('performer only', { status: 404 });
	},
} satisfies ExportedHandler<Env>;
