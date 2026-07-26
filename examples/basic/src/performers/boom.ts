import { Performer } from 'tsumugi/performer';

/** リトライとバックオフを見るための必ず失敗するperformer */
export class Boom extends Performer<unknown, void, {}, Env> {
	async perform(): Promise<void> {
		throw new Error('intentional failure');
	}
}
