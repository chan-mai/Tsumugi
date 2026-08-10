import { Performer } from 'tsumugi/performer';
import type { FailureNotice } from 'tsumugi';

// onFailureの通知先, 実際にはSlackやメールへ送る
export class NotifyFailure extends Performer<FailureNotice, void, {}, Env> {
	async perform(payload: FailureNotice): Promise<void> {
		console.log(`job failed: ${payload.jobId} (${payload.binding}) ${payload.state} - ${payload.error ?? 'no error recorded'}`);
	}
}
