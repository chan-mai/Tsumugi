import { Performer } from 'tsumugi/performer';

export class Report extends Performer<{ total: number; failed: number }, void, {}, Env> {
	async perform(payload: { total: number; failed: number }): Promise<void> {
		console.log(`greeted ${payload.total - payload.failed}/${payload.total}`);
	}
}
