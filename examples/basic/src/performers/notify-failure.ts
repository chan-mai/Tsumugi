import { Performer } from 'tsumugi/performer';
import type { FailureNotice } from 'tsumugi';

// onFailureの通知先, 実運用ではSlackやメールへ送信
export class NotifyFailure extends Performer<FailureNotice, void, {}, Env> {
	async perform(payload: FailureNotice): Promise<void> {
		console.log(`job failed: ${payload.jobId} (${payload.binding}) ${payload.state} - ${payload.error ?? 'no error recorded'}`);
	}
}
