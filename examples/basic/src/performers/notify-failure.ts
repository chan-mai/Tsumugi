import { Performer } from 'tsumugi/performer';
import type { FailureNotice } from 'tsumugi';

/** 失敗したジョブの知らせを受ける先(#30), 実際にはSlackやメールへ送る */
export class NotifyFailure extends Performer<FailureNotice, void, {}, Env> {
	async perform(payload: FailureNotice): Promise<void> {
		console.log(`job failed: ${payload.jobId} (${payload.binding}) ${payload.state} - ${payload.error ?? 'no error recorded'}`);
	}
}
