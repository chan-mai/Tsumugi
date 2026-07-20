import { DurableObject } from 'cloudflare:workers';

// M1でTsumugiのJob DOに置き換える,ここではバインディングの疎通確認のみ
export class JobShard extends DurableObject {
	async ping(): Promise<string> {
		return 'pong';
	}
}

export default {
	async fetch(): Promise<Response> {
		return new Response('tsumugi example');
	},
	async queue(): Promise<void> {},
};
