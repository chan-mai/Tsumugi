import { Performer } from 'tsumugi/performer';

export class ListNames extends Performer<{ prefix: string }, { names: string[] }, {}, Env> {
	async perform(payload: { prefix: string }) {
		return { names: [`${payload.prefix}-1`, `${payload.prefix}-2`, `${payload.prefix}-3`] };
	}
}
