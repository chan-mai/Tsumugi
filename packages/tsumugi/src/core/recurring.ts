import type { PayloadOf, Performers, ReqOf } from './api.js';
import type { Flows, InputOf, NodeJobOptions } from './flow.js';
import { InvalidCronError, nextCronAt, parseCron } from './cron.js';

/**
 * 定期実行の定義(ADR-0040)
 *
 * payloadとinputの写像関数はJSON化できないので, 定義はコードにしか無い
 * Scheduler DOへ渡るのは`normalizeSchedules`が返す正規形だけで, 関数はその都度closureから引く
 */

/** スケジュール名に許す文字, ジョブIDとrunIdのローカル部になるので区切り文字を弾く */
const SCHEDULE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const SCHEDULE_NAME_MAX = 64;

/** cron式の充足検査の起点, 現在時刻を使わないのは正規化を純粋に保つため */
const CRON_PROBE_AT = Date.UTC(2024, 0, 1);

export class InvalidScheduleError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidScheduleError';
	}
}

/** 発火時に写像関数へ渡す文脈, scheduledAtは発火の予定時刻 */
export type ScheduleContext = { scheduledAt: number };

type Resolvable<T> = T | ((context: ScheduleContext) => T | Promise<T>);

/**
 * scheduleに書けるジョブの設定
 * タイミングはスケジューラの所掌なのでdelayMs/runAtを持たず, uniqueKeyも受け付けない(ADR-0040)
 * 静的なuniqueKeyは予約が残る間の発火を吸収してしまう(ADR-0021)
 */
export type ScheduleJobOptions = Omit<NodeJobOptions, 'delayMs' | 'runAt'>;

/** uniqueKeyを必須と宣言したperformerはscheduleに使えない, ノードと同じ扱い(ADR-0033) */
type ScheduleBindings<M extends Performers> = { [K in keyof M]: ReqOf<M[K]>['uniqueKey'] extends true ? never : K }[keyof M];

type ConcurrencyKeyOption<R extends { concurrencyKey?: boolean }> = R['concurrencyKey'] extends true
	? { concurrencyKey: string }
	: { concurrencyKey?: string };

export type JobSchedule<M extends Performers> = {
	[K in ScheduleBindings<M> & string]: {
		binding: K;
		payload: Resolvable<PayloadOf<M[K]>>;
		/** shardsが2以上のbindingで必須, 発火先のshardを固定する */
		partitionKey?: string;
	} & ScheduleJobOptions &
		ConcurrencyKeyOption<ReqOf<M[K]>>;
}[ScheduleBindings<M> & string];

export type FlowSchedule<F extends Flows> = {
	[K in keyof F & string]: {
		flow: K;
		input: Resolvable<InputOf<F[K]>>;
		/** run全体の期限(ms), flow定義の期限より優先される(ADR-0039) */
		deadlineMs?: number;
	};
}[keyof F & string];

export type ScheduleTiming = ({ everyMs: number; cron?: never } | { cron: string; everyMs?: never }) & {
	/** 前回が終わっていない時刻に次回が来た場合の扱い, 既定は飛ばす(ADR-0040) */
	overlap?: 'skip' | 'overlap';
};

export type ScheduleDefs<M extends Performers, F extends Flows> = Record<string, (JobSchedule<M> | FlowSchedule<F>) & ScheduleTiming>;

/** 任意の定義を受ける型, 実行時の検証と発火はこの形で扱う */
export type AnyScheduleDef = {
	binding?: string;
	flow?: string;
	payload?: Resolvable<unknown>;
	input?: Resolvable<unknown>;
	partitionKey?: string;
	concurrencyKey?: string;
	deadlineMs?: number;
	everyMs?: number;
	cron?: string;
	overlap?: 'skip' | 'overlap';
} & ScheduleJobOptions;

export type AnySchedules = Record<string, AnyScheduleDef>;

/** DOへ保存する正規形, 関数は含まない */
export type NormalizedSchedule = {
	name: string;
	kind: 'job' | 'flow';
	target: string;
	everyMs: number | null;
	cron: string | null;
	overlap: 'skip' | 'overlap';
};

export type NormalizeContext = {
	bindings: readonly string[];
	flows: readonly string[];
	/** bindingのshard数, 2以上のbindingはpartitionKeyの明示が要る */
	shardsOf: (binding: string) => number;
};

/** タイミングの指定に混ざってはいけないキー, 型で防いでもJSからの利用があるので実行時にも弾く */
const FORBIDDEN_KEYS = ['uniqueKey', 'delayMs', 'runAt'] as const;

/**
 * 定義を検証して直列化可能な正規形へ落とす
 * 名前順に並べるので, 返るfingerprintは定義の記述順に依存しない
 */
export function normalizeSchedules(
	defs: AnySchedules,
	context: NormalizeContext,
): { schedules: NormalizedSchedule[]; fingerprint: string } {
	const schedules = Object.keys(defs)
		.sort()
		.map((name) => normalizeSchedule(name, defs[name]!, context));
	return { schedules, fingerprint: JSON.stringify(schedules) };
}

function normalizeSchedule(name: string, def: AnyScheduleDef, context: NormalizeContext): NormalizedSchedule {
	if (!SCHEDULE_NAME_PATTERN.test(name) || name.length > SCHEDULE_NAME_MAX) {
		throw new InvalidScheduleError(
			`invalid schedule name: ${JSON.stringify(name)} (alphanumeric, hyphen and underscore, up to ${SCHEDULE_NAME_MAX} chars)`,
		);
	}

	for (const key of FORBIDDEN_KEYS) {
		if (key in def) throw new InvalidScheduleError(`${key} is not allowed in a schedule: ${name}`);
	}

	if (def.overlap !== undefined && def.overlap !== 'skip' && def.overlap !== 'overlap') {
		throw new InvalidScheduleError(`overlap must be 'skip' or 'overlap': ${name}`);
	}

	if ((def.everyMs === undefined) === (def.cron === undefined)) {
		throw new InvalidScheduleError(`exactly one of everyMs and cron is required: ${name}`);
	}
	if (def.everyMs !== undefined && (!Number.isInteger(def.everyMs) || def.everyMs < 1000)) {
		throw new InvalidScheduleError(`everyMs must be an integer of at least 1000: ${name}`);
	}
	if (def.cron !== undefined) {
		try {
			// 解析に加えて到達可能性も見る, 2月31日のような式は発火の機会が永遠に来ない
			nextCronAt(parseCron(def.cron), CRON_PROBE_AT);
		} catch (error) {
			if (!(error instanceof InvalidCronError)) throw error;
			throw new InvalidScheduleError(`invalid cron in schedule ${name}: ${error.message}`);
		}
	}

	if ((def.binding === undefined) === (def.flow === undefined)) {
		throw new InvalidScheduleError(`exactly one of binding and flow is required: ${name}`);
	}

	if (def.binding !== undefined) {
		if (!context.bindings.includes(def.binding)) throw new InvalidScheduleError(`binding is not registered: ${name} -> ${def.binding}`);
		if (!('payload' in def)) throw new InvalidScheduleError(`payload is required: ${name}`);
		// shardの解決は発火のたびに行う, 実行時のthrowを定義時に前倒しする(ADR-0011)
		if (context.shardsOf(def.binding) > 1 && def.partitionKey === undefined) {
			throw new InvalidScheduleError(`partitionKey is required for a sharded binding: ${name} -> ${def.binding}`);
		}
	} else {
		if (!context.flows.includes(def.flow!)) throw new InvalidScheduleError(`flow is not registered: ${name} -> ${def.flow}`);
		if (!('input' in def)) throw new InvalidScheduleError(`input is required: ${name}`);
	}

	return {
		name,
		kind: def.binding !== undefined ? 'job' : 'flow',
		target: def.binding ?? def.flow!,
		everyMs: def.everyMs ?? null,
		cron: def.cron ?? null,
		overlap: def.overlap ?? 'skip',
	};
}

/**
 * 次回の発火時刻を返す
 * everyMsは初回の予定から位相を保って進め, 取り逃した分は発火せず飛ばす(ADR-0040)
 */
export function nextOccurrence(timing: { everyMs: number | null; cron: string | null }, previous: number | null, now: number): number {
	if (timing.everyMs !== null) {
		if (previous === null) return now + timing.everyMs;
		const base = Math.max(now, previous);
		return previous + timing.everyMs * (Math.floor((base - previous) / timing.everyMs) + 1);
	}
	return nextCronAt(parseCron(timing.cron ?? ''), Math.max(now, previous ?? now));
}
