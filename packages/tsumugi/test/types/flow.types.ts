/**
 * flow定義の型レベル検証,実行時テストではないので`tsc --noEmit`で検査する
 * 依存の受け取り口が実際に前段の戻り値の型になるかがここの主眼(ADR-0030)
 */
import { Performer } from '../../src/performer/entrypoint.js';
import type { JobContext } from '../../src/core/api.js';
import { createFlow } from '../../src/core/flow.js';

class FetchItems extends Performer<{ since: number }, { items: { id: string }[] }> {
	async perform(_payload: { since: number }, _ctx: JobContext) {
		return { items: [{ id: 'a' }] };
	}
}

class ProcessItem extends Performer<{ id: string }, { ok: boolean }> {
	async perform(_payload: { id: string }, _ctx: JobContext) {
		return { ok: true };
	}
}

/** 顧客単位で直列化したいのでconcurrencyKeyを必須にする */
class ChargeCard extends Performer<{ customerId: string }, { txId: string }, { concurrencyKey: true }> {
	async perform(_payload: { customerId: string }, _ctx: JobContext) {
		return { txId: 't' };
	}
}

/** uniqueKey必須のperformerはノードに使えない(ADR-0033) */
class SyncInventory extends Performer<{ sku: string }, void, { uniqueKey: true }> {
	async perform(_payload: { sku: string }, _ctx: JobContext) {}
}

const flow = createFlow({ FETCH: FetchItems, PROCESS: ProcessItem, CHARGE: ChargeCard, SYNC: SyncInventory });

export const order = flow<{ orderId: string; since: number }>((f) => {
	const fetched = f.node('fetch', 'FETCH', { input: (i) => ({ since: i.since }) });

	const charge = f.node('charge', 'CHARGE', {
		after: { fetched },
		input: (i) => ({ customerId: i.orderId }),
		concurrencyKey: (i) => i.orderId,
	});

	// overの要素型がinputのitemへ流れる
	const each = f.fanOut('process', 'PROCESS', {
		after: { fetched },
		over: (_i, d) => d.fetched.items,
		input: (item) => ({ id: item.id }),
	});

	// 合流,受け取り口の名前は after のキーそのもの
	f.node('report', 'PROCESS', {
		after: { each, charge },
		input: (_i, d) => ({ id: `${d.each.total}-${d.charge.txId}` }),
	});
});

/** 発火条件で受け取り口の型が変わる(ADR-0041) */
export const triggers = flow<{ orderId: string }>((f) => {
	const fetched = f.node('fetch', 'FETCH', { input: () => ({ since: 0 }) });

	// successでは依存の戻り値が揃う
	f.node('ok', 'PROCESS', { after: { fetched }, input: (_i, d) => ({ id: d.fetched.items[0]!.id }) });

	// failureとalwaysでは失敗した依存の戻り値が無い
	f.node('cleanup', 'PROCESS', {
		after: { fetched },
		trigger: 'failure',
		input: (_i, d) => ({ id: d.fetched?.items[0]?.id ?? 'none' }),
	});
	f.node('always', 'PROCESS', {
		after: { fetched },
		trigger: 'always',
		when: (_i, d) => d.fetched !== undefined,
		input: () => ({ id: 'x' }),
	});
});

export const negatives = flow<{ orderId: string }>((f) => {
	// @ts-expect-error uniqueKey必須のperformerはノードに指定できない(ADR-0033)
	f.node('sync', 'SYNC', { input: () => ({ sku: 'x' }) });

	// @ts-expect-error 未登録のbinding
	f.node('unknown', 'NOPE', { input: () => ({}) });

	// @ts-expect-error payloadの型が違う
	f.node('fetch', 'FETCH', { input: () => ({ since: 'now' }) });

	// @ts-expect-error concurrencyKeyが必須
	f.node('charge', 'CHARGE', { input: (i) => ({ customerId: i.orderId }) });

	// @ts-expect-error uniqueKeyはノードでは受け付けない(ADR-0033)
	f.node('fetch2', 'FETCH', { input: () => ({ since: 1 }), uniqueKey: 'sku-1' });

	const fetched = f.node('fetch3', 'FETCH', { input: () => ({ since: 1 }) });
	f.node('after-typo', 'PROCESS', {
		after: { fetched },
		// @ts-expect-error 宣言していない受け取り口
		input: (_i, d) => ({ id: d.missing.items[0].id }),
	});

	f.node('bad-trigger', 'PROCESS', {
		after: { fetched },
		// @ts-expect-error 発火条件は3つのいずれか(ADR-0041)
		trigger: 'maybe',
		input: () => ({ id: 'x' }),
	});

	f.node('lenient-deps', 'PROCESS', {
		after: { fetched },
		trigger: 'always',
		// @ts-expect-error 成功していない依存は戻り値を持たない
		input: (_i, d) => ({ id: d.fetched.items[0].id }),
	});

	f.node('bad-when', 'PROCESS', {
		after: { fetched },
		// @ts-expect-error 判定はbooleanを返す
		when: (_i, d) => d.fetched.items.length,
		input: () => ({ id: 'x' }),
	});
});
