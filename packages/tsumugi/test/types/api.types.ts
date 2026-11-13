// 型レベル検証, vitest対象外で`tsc --noEmit`で検査
// 不要になった@ts-expect-errorはTS2578で失敗、検査の形骸化防止
import { Performer } from '../../src/performer/entrypoint.js';
import { defineTsumugi } from '../../src/worker.js';

import type { JobContext } from '../../src/core/api.js';

class SendMail extends Performer<{ to: string; subject: string }> {
	async perform(payload: { to: string; subject: string }, _ctx: JobContext) {
		return payload.to;
	}
}

class ChargeCard extends Performer<{ customerId: string; amountJpy: number }, void, { concurrencyKey: true }> {
	async perform(_payload: { customerId: string; amountJpy: number }, _ctx: JobContext) {}
}

class SyncInventory extends Performer<{ sku: string }, void, { uniqueKey: true }> {
	async perform(_payload: { sku: string }, _ctx: JobContext) {}
}

// 実装のない変数への型テストは不可(#5 / ADR-0010)
const tsumugi = defineTsumugi({ performers: { MAIL: SendMail, CHARGE: ChargeCard, SYNC: SyncInventory } });
declare const env: never;
const q = tsumugi.jobs(env);

export function typeChecks() {
	void q.enqueue('MAIL', { to: 'a@example.com', subject: 'hi' });

	// @ts-expect-error subjectが無い
	void q.enqueue('MAIL', { to: 'a@example.com' });
	// @ts-expect-error amountJpyはnumber
	void q.enqueue('CHARGE', { customerId: 'c1', amountJpy: '100' }, { concurrencyKey: 'c1' });

	// @ts-expect-error未定義のbinding
	void q.enqueue('NOPE', {});

	void q.enqueue('MAIL', { to: 'a@example.com', subject: 'hi' }, { priority: 5 });

	void q.enqueue('CHARGE', { customerId: 'c1', amountJpy: 1200 }, { concurrencyKey: 'cust:c1' });
	// @ts-expect-error optionsごとの省略は不可
	void q.enqueue('CHARGE', { customerId: 'c1', amountJpy: 1200 });
	// @ts-expect-error concurrencyKeyが無い
	void q.enqueue('CHARGE', { customerId: 'c1', amountJpy: 1200 }, { priority: 1 });

	void q.enqueue('SYNC', { sku: 'X-1' }, { uniqueKey: 'sku:X-1' });
	// @ts-expect-error uniqueKeyが無い
	void q.enqueue('SYNC', { sku: 'X-1' }, {});

	void q.enqueue('MAIL', { to: 'a@example.com', subject: 'hi' }, { concurrencyKey: 'domain:example.com' });

	// バルクのbinding別推論はスパイクの測定結果で必須化
	void q.enqueueMany([
		{ binding: 'MAIL', payload: { to: 'a@example.com', subject: 'hi' } },
		{ binding: 'CHARGE', payload: { customerId: 'c1', amountJpy: 1200 }, options: { concurrencyKey: 'cust:c1' } },
	]);

	void q.enqueueMany([
		// @ts-expect-error concurrencyKeyが無い
		{ binding: 'CHARGE', payload: { customerId: 'c1', amountJpy: 1200 } },
	]);

	void q.enqueueMany([
		// @ts-expect-error MAILにCHARGEのpayload
		{ binding: 'MAIL', payload: { customerId: 'c1', amountJpy: 1200 } },
	]);

	const many: Promise<string[]> = q.enqueueMany([]);
	const one: Promise<string> = q.enqueue('MAIL', { to: 'a@example.com', subject: 'hi' });
	void many;
	void one;

	void tsumugi.enqueue(env, { binding: 'MAIL', payload: { to: 'a@example.com', subject: 'hi' } });
	// @ts-expect-error subjectが無い
	void tsumugi.enqueue(env, { binding: 'MAIL', payload: { to: 'a@example.com' } });
	void tsumugi.enqueue(env, { binding: 'CHARGE', payload: { customerId: 'c1', amountJpy: 1200 }, concurrencyKey: 'cust:c1' });
	// @ts-expect-error concurrencyKeyが無い
	void tsumugi.enqueue(env, { binding: 'CHARGE', payload: { customerId: 'c1', amountJpy: 1200 } });
	// @ts-expect-error payloadの取り違え
	void tsumugi.enqueue(env, { binding: 'MAIL', payload: { customerId: 'c1', amountJpy: 1200 } });
	void tsumugi.enqueueMany(env, [{ binding: 'SYNC', payload: { sku: 'X-1' }, uniqueKey: 'sku:X-1' }]);
	// @ts-expect-error uniqueKeyが無い
	void tsumugi.enqueueMany(env, [{ binding: 'SYNC', payload: { sku: 'X-1' } }]);
}

// 全performerは同一Worker環境で初期化(#5)
type EnvA = { A_DB: string };
type EnvB = { B_QUEUE: string };
class NeedsA extends Performer<{ x: number }, void, {}, EnvA> {
	async perform(_payload: { x: number }, _ctx: JobContext) {}
}
class NeedsB extends Performer<{ y: number }, void, {}, EnvB> {
	async perform(_payload: { y: number }, _ctx: JobContext) {}
}

const both = defineTsumugi({ performers: { A: NeedsA, B: NeedsB } });
declare const fullEnv: EnvA & EnvB;

export function envIsIntersection() {
	both.jobs(fullEnv);
	// @ts-expect-error A_DBしか無い環境はB_QUEUEを満たさず拒否
	both.jobs({ A_DB: 'x' } as EnvA);
}
