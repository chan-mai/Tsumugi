import { Performer, type JobContext } from 'tsumugi/performer';

/** 進捗を報告しながら進む長いジョブ */
export class Slow extends Performer<{ steps: number }, void, {}, Env> {
	async perform(payload: { steps: number }, ctx: JobContext): Promise<void> {
		for (let step = 0; step < payload.steps; step++) {
			await new Promise((resolve) => setTimeout(resolve, 1_000));
			await ctx.heartbeat((step + 1) / payload.steps);
		}
	}
}
