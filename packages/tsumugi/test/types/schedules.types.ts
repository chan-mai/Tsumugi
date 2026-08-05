/**
 * scheduleの型レベル検証, 実行時テストではないので`tsc --noEmit`で検査する
 * binding名とflow名からpayloadとinputの型が決まるかがここの主眼(ADR-0040)
 */
import { Performer } from '../../src/performer/entrypoint.js';
import type { JobContext } from '../../src/core/api.js';
import { createFlow } from '../../src/core/flow.js';
import { defineTsumugi } from '../../src/worker.js';

class Poll extends Performer<{ prefix: string }, { names: string[] }> {
	async perform(_payload: { prefix: string }, _ctx: JobContext) {
		return { names: ['a'] };
	}
}

/** 顧客単位で直列化したいのでconcurrencyKeyを必須にする */
class Charge extends Performer<{ customerId: string }, void, { concurrencyKey: true }> {
	async perform(_payload: { customerId: string }, _ctx: JobContext) {}
}

/** uniqueKey必須のperformerはscheduleに使えない(ADR-0040) */
class Sync extends Performer<{ sku: string }, void, { uniqueKey: true }> {
	async perform(_payload: { sku: string }, _ctx: JobContext) {}
}

const performers = { POLL: Poll, CHARGE: Charge, SYNC: Sync };
const flow = createFlow(performers);

const flows = {
	REPORT: flow<{ until: number }>((f) => {
		f.node('poll', 'POLL', { input: () => ({ prefix: 'x' }) });
	}),
};

export const positives = defineTsumugi({
	performers,
	flows,
	schedules: {
		// payloadの型はbindingから決まる
		'poll-fixed': { binding: 'POLL', payload: { prefix: 'a' }, everyMs: 60_000 },
		// 写像関数は発火の予定時刻を受け取る, 戻り値の型も同じく縛られる
		'poll-fn': { binding: 'POLL', payload: ({ scheduledAt }) => ({ prefix: `a-${scheduledAt}` }), cron: '0 * * * *' },
		// 必須のconcurrencyKeyはscheduleでも要る
		charge: { binding: 'CHARGE', payload: { customerId: 'c1' }, concurrencyKey: 'c1', everyMs: 3_600_000 },
		// inputの型はflowから決まる
		nightly: { flow: 'REPORT', input: ({ scheduledAt }) => ({ until: scheduledAt }), cron: '0 3 * * *', overlap: 'overlap' },
	},
});

defineTsumugi({
	performers,
	flows,
	schedules: {
		// @ts-expect-error 未登録のbinding
		unknown: { binding: 'NOPE', payload: {}, everyMs: 60_000 },
	},
});

defineTsumugi({
	performers,
	flows,
	schedules: {
		// @ts-expect-error payloadの型が違う
		'bad-payload': { binding: 'POLL', payload: { prefix: 1 }, everyMs: 60_000 },
	},
});

defineTsumugi({
	performers,
	flows,
	schedules: {
		// @ts-expect-error uniqueKey必須のperformerはscheduleに指定できない
		sync: { binding: 'SYNC', payload: { sku: 'x' }, everyMs: 60_000 },
	},
});

defineTsumugi({
	performers,
	flows,
	schedules: {
		// @ts-expect-error concurrencyKeyが必須
		charge: { binding: 'CHARGE', payload: { customerId: 'c1' }, everyMs: 60_000 },
	},
});

defineTsumugi({
	performers,
	flows,
	schedules: {
		// @ts-expect-error uniqueKeyはscheduleでは受け付けない
		'with-unique': { binding: 'POLL', payload: { prefix: 'a' }, everyMs: 60_000, uniqueKey: 'k' },
	},
});

defineTsumugi({
	performers,
	flows,
	schedules: {
		// @ts-expect-error タイミングはスケジューラの所掌なのでdelayMsは書けない
		'with-delay': { binding: 'POLL', payload: { prefix: 'a' }, everyMs: 60_000, delayMs: 100 },
	},
});

defineTsumugi({
	performers,
	flows,
	schedules: {
		// @ts-expect-error everyMsとcronは排他
		both: { binding: 'POLL', payload: { prefix: 'a' }, everyMs: 60_000, cron: '0 * * * *' },
	},
});

defineTsumugi({
	performers,
	flows,
	schedules: {
		// @ts-expect-error 未登録のflow
		'bad-flow': { flow: 'NOPE', input: {}, everyMs: 60_000 },
	},
});

defineTsumugi({
	performers,
	flows,
	schedules: {
		// @ts-expect-error inputの型が違う
		'bad-input': { flow: 'REPORT', input: { until: 'now' }, everyMs: 60_000 },
	},
});
