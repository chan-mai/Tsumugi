import type { PayloadOf, Performers, ReqOf } from './api.js';
import type { Flows, InputOf, NodeJobOptions } from './flow.js';
import { InvalidCronError, nextCronAt, parseCron, resolveTimeZone } from './cron.js';

// 定期実行定義, payloadとinputの関数はJSON化不能でコードにのみ存在(ADR-0040)
// Scheduler DOへは`normalizeSchedules`の正規形のみ送信, 関数は都度closureから取得

// ジョブID, runIdのlocalIdに埋込, 区切り文字拒否
const SCHEDULE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const SCHEDULE_NAME_MAX = 64;

// cron式の到達可能性検査の起点, 正規化の純粋性維持で現在時刻不使用
const CRON_PROBE_AT = Date.UTC(2024, 0, 1);

export class InvalidScheduleError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidScheduleError';
	}
}

/** scheduledAtは予定発火時刻 */
export type ScheduleContext = { scheduledAt: number };

type Resolvable<T> = T | ((context: ScheduleContext) => T | Promise<T>);

/**
 * scheduleのジョブ設定, タイミングはスケジューラ管理でdelayMs, runAt不可(ADR-0040)
 * uniqueKey不可, 静的値は予約残存中の発火を無効化(ADR-0021)
 */
export type ScheduleJobOptions = Omit<NodeJobOptions, 'delayMs' | 'runAt'>;

type ScheduleBindings<M extends Performers> = { [K in keyof M]: ReqOf<M[K]>['uniqueKey'] extends true ? never : K }[keyof M];

type ConcurrencyKeyOption<R extends { concurrencyKey?: boolean }> = R['concurrencyKey'] extends true
	? { concurrencyKey: string }
	: { concurrencyKey?: string };

export type JobSchedule<M extends Performers> = {
	[K in ScheduleBindings<M> & string]: {
		binding: K;
		payload: Resolvable<PayloadOf<M[K]>>;
		/** shardsが2以上のbindingで必須, 発火先のshardを固定 */
		partitionKey?: string;
	} & ScheduleJobOptions &
		ConcurrencyKeyOption<ReqOf<M[K]>>;
}[ScheduleBindings<M> & string];

export type FlowSchedule<F extends Flows> = {
	[K in keyof F & string]: {
		flow: K;
		input: Resolvable<InputOf<F[K]>>;
		/** run全体の期限(ms), flow定義の期限より優先(ADR-0039) */
		deadlineMs?: number;
	};
}[keyof F & string];

export type ScheduleTiming = (
	{ everyMs: number; cron?: never; timeZone?: never } | { cron: string; everyMs?: never; timeZone?: string }
) & {
	/** 前回実行中に次回時刻到来時の扱い, 既定は'skip'(ADR-0040) */
	overlap?: 'skip' | 'overlap';
};

export type ScheduleDefs<M extends Performers, F extends Flows> = Record<string, (JobSchedule<M> | FlowSchedule<F>) & ScheduleTiming>;

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
	timeZone?: string;
	overlap?: 'skip' | 'overlap';
} & ScheduleJobOptions;

export type AnySchedules = Record<string, AnyScheduleDef>;

export type NormalizedSchedule = {
	name: string;
	kind: 'job' | 'flow';
	target: string;
	everyMs: number | null;
	cron: string | null;
	timeZone: string;
	overlap: 'skip' | 'overlap';
};

type NormalizeContext = {
	bindings: readonly string[];
	flows: readonly string[];
	shardsOf: (binding: string) => number;
};

// JSからの利用考慮で実行時も検査
const FORBIDDEN_KEYS = ['uniqueKey', 'delayMs', 'runAt'] as const;

/** 名前順整列でfingerprintは記述順に非依存 */
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
	if (def.everyMs !== undefined && 'timeZone' in def) {
		throw new InvalidScheduleError(`timeZone is only allowed with cron: ${name}`);
	}

	let timeZone = 'UTC';
	if (def.cron !== undefined) {
		if (def.timeZone !== undefined && typeof def.timeZone !== 'string') {
			throw new InvalidScheduleError(`timeZone must be an IANA time zone: ${name}`);
		}
		try {
			timeZone = resolveTimeZone(def.timeZone ?? 'UTC');
		} catch (error) {
			if (!(error instanceof InvalidCronError)) throw error;
			throw new InvalidScheduleError(`invalid timeZone in schedule ${name}: ${error.message}`);
		}
		try {
			// 到達可能性も検査, 2月31日等は発火機会なし
			nextCronAt(parseCron(def.cron), CRON_PROBE_AT, timeZone);
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
		// shard解決は発火時, そのエラーを定義時に検出(ADR-0011)
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
		timeZone,
		overlap: def.overlap ?? 'skip',
	};
}

/** everyMsは初回予定からの位相維持, 経過済み分は省略(ADR-0040) */
export function nextOccurrence(
	timing: { everyMs: number | null; cron: string | null; timeZone?: string },
	previous: number | null,
	now: number,
): number {
	if (timing.everyMs !== null) {
		if (previous === null) return now + timing.everyMs;
		const base = Math.max(now, previous);
		return previous + timing.everyMs * (Math.floor((base - previous) / timing.everyMs) + 1);
	}
	return nextCronAt(parseCron(timing.cron ?? ''), Math.max(now, previous ?? now), timing.timeZone);
}
