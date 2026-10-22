import { Performer, type JobContext } from 'tsumugi/performer';

export class SendMail extends Performer<{ to: string; subject: string }, void, {}, Env> {
	async perform(payload: { to: string; subject: string }, ctx: JobContext): Promise<void> {
		console.log(`send mail to ${payload.to} (${ctx.jobId}, attempt ${ctx.attempt})`);
	}
}

// 名前付きexportに加えてdefault exportも必要
export default {
	async fetch(): Promise<Response> {
		return new Response('performer only', { status: 404 });
	},
} satisfies ExportedHandler<Env>;
