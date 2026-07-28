import { Performer } from 'tsumugi/performer';

export class Hello extends Performer<{ name: string }, void, {}, Env> {
	async perform(payload: { name: string }): Promise<void> {
		console.log(`hello, ${payload.name}`);
	}
}
