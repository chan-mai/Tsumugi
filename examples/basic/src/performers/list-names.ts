import { Performer } from 'tsumugi/performer';

// Flowの前段, 戻り値が後段のpayload
export class ListNames extends Performer<{ prefix: string }, { names: string[] }, {}, Env> {
	async perform(payload: { prefix: string }) {
		return { names: [`${payload.prefix}-1`, `${payload.prefix}-2`, `${payload.prefix}-3`] };
	}
}
