import { describe, expect, it, vi } from 'vitest';
import { createClient } from '../../src/client/enqueue.js';
import type { EnqueueInput } from '../../src/do/job-shard.js';

function capture() {
	const calls: { inputs: readonly EnqueueInput[]; settings: unknown }[] = [];
	const stub = {
		id: { toString: () => 'stub' },
		enqueueMany: async (inputs: readonly EnqueueInput[], settings: unknown) => {
			calls.push({ inputs, settings });
			return inputs.map((_, i) => `id-${i}`);
		},
	};
	const env = { JOB_SHARD: { idFromName: (name: string) => name, get: () => stub } } as never;
	return { calls, env };
}

describe('onEnqueueによる既定値の付与(#96)', () => {
	it('フックの戻り値がundefinedのキーへ適用される', async () => {
		const { calls, env } = capture();
		const client = createClient({}, {}, { onEnqueue: () => ({ timeoutMs: 45_000, priority: 5 }) });

		await client.enqueue(env, { binding: 'A', payload: {} });

		expect(calls[0]!.inputs[0]).toMatchObject({ binding: 'A', timeoutMs: 45_000, priority: 5 });
	});

	it('呼び出し側の明示値が優先される', async () => {
		const { calls, env } = capture();
		const client = createClient({}, {}, { onEnqueue: () => ({ timeoutMs: 45_000, maxAttempts: 9 }) });

		await client.enqueue(env, { binding: 'A', payload: {}, timeoutMs: 1_000 });

		expect(calls[0]!.inputs[0]).toMatchObject({ timeoutMs: 1_000, maxAttempts: 9 });
	});

	it('明示のundefinedはフックの値を消さない', async () => {
		const { calls, env } = capture();
		const client = createClient({}, {}, { onEnqueue: () => ({ priority: 5 }) });

		// 型上不可の明示undefinedもJSからは渡り得る
		await client.enqueue(env, { binding: 'A', payload: {}, priority: undefined } as unknown as EnqueueInput);

		expect(calls[0]!.inputs[0]).toMatchObject({ priority: 5 });
	});

	it('排他のオプションは片方が決まればもう片方を適用しない', async () => {
		const { calls, env } = capture();
		const client = createClient({}, {}, { onEnqueue: () => ({ delayMs: 1_000, runAt: 999, expiresAt: 10, expiresInMs: 20 }) });

		await client.enqueue(env, { binding: 'A', payload: {}, runAt: 123 });

		const input = calls[0]!.inputs[0]!;
		expect(input.runAt).toBe(123);
		expect(input.delayMs).toBeUndefined();
		expect(input.expiresAt).toBe(10);
		expect(input.expiresInMs).toBeUndefined();
	});

	it('宛先と識別子はフックで変更できない', async () => {
		const { calls, env } = capture();
		// 型上不可のキーも実行時は混入し得る
		const client = createClient({}, {}, { onEnqueue: () => ({ binding: 'B', id: 'X#0:hijack', payload: { x: 1 } }) as never });

		await client.enqueue(env, { binding: 'A', payload: {} });

		expect(calls[0]!.inputs[0]).toMatchObject({ binding: 'A', payload: {} });
		expect(calls[0]!.inputs[0]!.id).toBeUndefined();
	});

	it('フック由来の不正なtraceparentも送信前に拒否される', async () => {
		const idFromName = vi.fn();
		const get = vi.fn();
		const client = createClient({}, {}, { onEnqueue: () => ({ traceparent: 'invalid' }) });

		await expect(client.enqueueMany({ JOB_SHARD: { idFromName, get } } as never, [{ binding: 'A', payload: {} }])).rejects.toThrow(
			/traceparent/,
		);
		expect(get).not.toHaveBeenCalled();
	});
});
