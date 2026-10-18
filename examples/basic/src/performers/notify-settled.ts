import { Performer } from 'tsumugi/performer';
import type { SettledNotice } from 'tsumugi';

// onSettledの通知先
export class NotifySettled extends Performer<SettledNotice, void, {}, Env> {
	async perform(payload: SettledNotice): Promise<void> {
		console.log(`job settled: ${payload.jobId} (${payload.binding}) ${payload.state}`);
	}
}
