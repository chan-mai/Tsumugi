import { describe, expect, it, vi } from 'vitest';
import { createClient } from '../../src/client/enqueue.js';

describe('投入前のtraceparent検証', () => {
	it('別bindingの不正な値がある場合は全DOへの送信を開始しない', async () => {
		const idFromName = vi.fn();
		const get = vi.fn();
		const client = createClient();
		await expect(
			client.enqueueMany({ JOB_SHARD: { idFromName, get } } as never, [
				{ binding: 'FIRST', payload: {}, traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
				{ binding: 'SECOND', payload: {}, traceparent: 'invalid' },
			]),
		).rejects.toThrow(/traceparent/);
		expect(idFromName).not.toHaveBeenCalled();
		expect(get).not.toHaveBeenCalled();
	});
});
