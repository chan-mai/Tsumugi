/**
 * 型レベルの検証,実行時テストではないのでvitestからは読ませず`tsc --noEmit`で検査する
 * @ts-expect-errorが不要になるとTS2578で落ちるため検査が形骸化しない
 * (実際に1つを正しいコードへ変えてTS2578が出ることを確認済み)
 */
import { Performer } from '../../src/core/api.js';
import type { JobContext, JobQueue } from '../../src/core/api.js';

class SendMail extends Performer<{ to: string; subject: string }> {
	async perform(payload: { to: string; subject: string }, _ctx: JobContext) {
		return payload.to;
	}
}

/** 顧客単位で直列化したいのでconcurrencyKeyを必須にする */
class ChargeCard extends Performer<{ customerId: string; amountJpy: number }, void, { concurrencyKey: true }> {
	async perform(_payload: { customerId: string; amountJpy: number }, _ctx: JobContext) {}
}

/** 重複投入を防ぎたいのでuniqueKeyを必須にする */
class SyncInventory extends Performer<{ sku: string }, void, { uniqueKey: true }> {
	async perform(_payload: { sku: string }, _ctx: JobContext) {}
}

type M = { MAIL: SendMail; CHARGE: ChargeCard; SYNC: SyncInventory };
declare const q: JobQueue<M>;

// 実行はしない,型検査のみが目的
export function typeChecks() {
	// payloadがbindingから推論される
	q.enqueue('MAIL', { to: 'a@example.com', subject: 'hi' });

	// payloadの型が違えばエラー
	// @ts-expect-error subjectが無い
	q.enqueue('MAIL', { to: 'a@example.com' });
	// @ts-expect-error amountJpyはnumber
	q.enqueue('CHARGE', { customerId: 'c1', amountJpy: '100' }, { concurrencyKey: 'c1' });

	// 存在しないbindingはエラー
	// @ts-expect-error未定義のbinding
	q.enqueue('NOPE', {});

	// 印の無いperformerはoptionsを省略できる
	q.enqueue('MAIL', { to: 'a@example.com', subject: 'hi' }, { priority: 5 });

	// concurrencyKey必須のperformerは渡し忘れがコンパイルエラー(ADR-0010)
	q.enqueue('CHARGE', { customerId: 'c1', amountJpy: 1200 }, { concurrencyKey: 'cust:c1' });
	// @ts-expect-error optionsごと省略できない
	q.enqueue('CHARGE', { customerId: 'c1', amountJpy: 1200 });
	// @ts-expect-error concurrencyKeyが無い
	q.enqueue('CHARGE', { customerId: 'c1', amountJpy: 1200 }, { priority: 1 });

	// uniqueKey必須も同様
	q.enqueue('SYNC', { sku: 'X-1' }, { uniqueKey: 'sku:X-1' });
	// @ts-expect-error uniqueKeyが無い
	q.enqueue('SYNC', { sku: 'X-1' }, {});

	// 印の無いperformerでも任意のキーは渡せる
	q.enqueue('MAIL', { to: 'a@example.com', subject: 'hi' }, { concurrencyKey: 'domain:example.com' });

	// バルクでもbindingごとにpayloadが推論される(スパイクの測定結果により必須化)
	q.enqueueMany([
		{ binding: 'MAIL', payload: { to: 'a@example.com', subject: 'hi' } },
		{ binding: 'CHARGE', payload: { customerId: 'c1', amountJpy: 1200 }, options: { concurrencyKey: 'cust:c1' } },
	]);

	// 必須の印はバルクでも効く
	q.enqueueMany([
		// @ts-expect-error concurrencyKeyが無い
		{ binding: 'CHARGE', payload: { customerId: 'c1', amountJpy: 1200 } },
	]);

	// payloadの取り違えを検出する
	q.enqueueMany([
		// @ts-expect-error MAILにCHARGEのpayload
		{ binding: 'MAIL', payload: { customerId: 'c1', amountJpy: 1200 } },
	]);

	// 戻り値
	const many: Promise<string[]> = q.enqueueMany([]);
	const one: Promise<string> = q.enqueue('MAIL', { to: 'a@example.com', subject: 'hi' });
	void many;
	void one;
}
