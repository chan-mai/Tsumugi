import { Performer } from 'tsumugi/performer';

// リトライとバックオフの確認用, 必ず失敗
export class Boom extends Performer<unknown, void, {}, Env> {
	async perform(): Promise<void> {
		throw new Error('intentional failure');
	}
}
