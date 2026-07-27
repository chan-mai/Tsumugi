import { Performer } from 'tsumugi/performer';

export class Greet extends Performer<{ name: string }, { greeted: string }, {}, Env> {
	async perform(payload: { name: string }) {
		return { greeted: payload.name };
	}
}
