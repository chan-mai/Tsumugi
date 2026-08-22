/**
 * cron式の解釈(ADR-0040)
 *
 * 5フィールド(分 時 日 月 曜日)を指定タイムゾーンの分精度で評価
 * 対応する記法は数値, `*`, `,`, `-`, `/`のみ, 名前(JAN, MON等)は非対応
 */

export class InvalidCronError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidCronError';
	}
}

export type CronSpec = {
	minutes: ReadonlySet<number>;
	hours: ReadonlySet<number>;
	daysOfMonth: ReadonlySet<number>;
	months: ReadonlySet<number>;
	daysOfWeek: ReadonlySet<number>;
	/** 日と曜日の両方に制限がある場合はOR判定, 標準cronの規則 */
	restrictedDayOfMonth: boolean;
	restrictedDayOfWeek: boolean;
};

const FIELDS = [
	{ label: 'minute', min: 0, max: 59 },
	{ label: 'hour', min: 0, max: 23 },
	{ label: 'day of month', min: 1, max: 31 },
	{ label: 'month', min: 1, max: 12 },
	{ label: 'day of week', min: 0, max: 7 },
] as const;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** 探索の上限日数, うるう日を含むどの周期もこの窓に必ず出現 */
const SEARCH_DAYS = 366 * 5;

type LocalDateTime = {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
};

const LOCAL_SEARCH_SEEDS = [-2 * DAY_MS, -DAY_MS, -12 * HOUR_MS, 0, 12 * HOUR_MS, DAY_MS, 2 * DAY_MS] as const;

/** `A`または`A-B`を[開始, 終了]へ, `*`はフィールドの全域 */
function parseRange(text: string, min: number, max: number, label: string): [number, number] {
	if (text === '*') return [min, max];
	const bounds = text.split('-');
	if (bounds.length > 2) throw new InvalidCronError(`invalid ${label} range: ${text}`);
	const from = parseValue(bounds[0]!, min, max, label);
	const to = bounds.length === 2 ? parseValue(bounds[1]!, min, max, label) : from;
	if (from > to) throw new InvalidCronError(`${label} range is reversed: ${text}`);
	return [from, to];
}

function parseValue(text: string, min: number, max: number, label: string): number {
	if (!/^\d+$/.test(text)) throw new InvalidCronError(`invalid ${label} value: ${text}`);
	const value = Number(text);
	if (value < min || value > max) throw new InvalidCronError(`${label} value out of range (${min}-${max}): ${text}`);
	return value;
}

function parseField(text: string, min: number, max: number, label: string): Set<number> {
	const values = new Set<number>();
	for (const part of text.split(',')) {
		if (part === '') throw new InvalidCronError(`empty ${label} entry: ${text}`);
		const [range, ...rest] = part.split('/');
		if (rest.length > 1) throw new InvalidCronError(`invalid ${label} step: ${part}`);
		// ステップは範囲か`*`にのみ付く, 単一値へのステップは範囲の書き漏らしと区別不能
		if (rest.length === 1 && range !== '*' && !range!.includes('-')) {
			throw new InvalidCronError(`step requires a range: ${part}`);
		}
		const step = rest.length === 1 ? parseValue(rest[0]!, 1, max - min + 1, `${label} step`) : 1;
		const [from, to] = parseRange(range!, min, max, label);
		for (let value = from; value <= to; value += step) values.add(value);
	}
	return values;
}

export function parseCron(expression: string): CronSpec {
	const fields = expression.trim().split(/\s+/);
	if (fields.length !== FIELDS.length) {
		throw new InvalidCronError(`expected 5 fields (minute hour day month weekday): ${expression}`);
	}

	const parsed = fields.map((text, index) => {
		const { label, min, max } = FIELDS[index]!;
		return parseField(text, min, max, label);
	});

	// 曜日の7は0と同じ日曜, 判定はgetUTCDay()の0-6
	const daysOfWeek = new Set([...parsed[4]!].map((value) => (value === 7 ? 0 : value)));

	return {
		minutes: parsed[0]!,
		hours: parsed[1]!,
		daysOfMonth: parsed[2]!,
		months: parsed[3]!,
		daysOfWeek,
		restrictedDayOfMonth: fields[2] !== '*',
		restrictedDayOfWeek: fields[4] !== '*',
	};
}

/** 標準cronの規則, 日と曜日の両方に制限がある場合はどちらか一致で可 */
function dayMatches(spec: CronSpec, date: Date): boolean {
	const domOk = spec.daysOfMonth.has(date.getUTCDate());
	const dowOk = spec.daysOfWeek.has(date.getUTCDay());
	return spec.restrictedDayOfMonth && spec.restrictedDayOfWeek ? domOk || dowOk : domOk && dowOk;
}

export function resolveTimeZone(timeZone: string): string {
	if (timeZone === 'UTC') return 'UTC';
	let resolved: string;
	try {
		resolved = new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;
	} catch {
		throw new InvalidCronError(`invalid time zone: ${timeZone}`);
	}
	if (resolved.startsWith('+') || resolved.startsWith('-')) {
		throw new InvalidCronError(`invalid time zone: ${timeZone}`);
	}
	return resolved;
}

function localFormatter(timeZone: string): Intl.DateTimeFormat {
	return new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
		timeZone,
		calendar: 'gregory',
		numberingSystem: 'latn',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23',
	});
}

function localDateTime(formatter: Intl.DateTimeFormat, instant: number): LocalDateTime {
	const value: LocalDateTime = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
	for (const part of formatter.formatToParts(new Date(instant))) {
		switch (part.type) {
			case 'year':
			case 'month':
			case 'day':
			case 'hour':
			case 'minute':
			case 'second':
				value[part.type] = Number(part.value);
		}
	}
	return value;
}

const localEpoch = (value: LocalDateTime): number =>
	Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second);

const sameLocalDateTime = (left: LocalDateTime, right: LocalDateTime): boolean =>
	left.year === right.year &&
	left.month === right.month &&
	left.day === right.day &&
	left.hour === right.hour &&
	left.minute === right.minute &&
	left.second === right.second;

/** ローカル日時に対応する最初のUTC時刻, 存在しない日時はnull */
function earliestInstant(formatter: Intl.DateTimeFormat, target: LocalDateTime): number | null {
	const targetEpoch = localEpoch(target);
	let earliest: number | null = null;

	for (const seed of LOCAL_SEARCH_SEEDS) {
		let candidate = targetEpoch + seed;
		for (let attempt = 0; attempt < 6; attempt++) {
			const adjustment = targetEpoch - localEpoch(localDateTime(formatter, candidate));
			if (adjustment === 0) break;
			candidate += adjustment;
		}

		if (!sameLocalDateTime(localDateTime(formatter, candidate), target)) continue;
		if (earliest === null || candidate < earliest) earliest = candidate;
	}

	return earliest;
}

function nextCronAtUtc(spec: CronSpec, afterMs: number): number {
	const hours = [...spec.hours].sort((a, b) => a - b);
	const minutes = [...spec.minutes].sort((a, b) => a - b);

	// 日単位で進め一致する日だけ時分を走査, 分単位の全走査は5年窓で数百万回
	let cursor = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
	for (let day = 0; day < SEARCH_DAYS; day++) {
		const date = new Date(cursor);
		if (spec.months.has(date.getUTCMonth() + 1) && dayMatches(spec, date)) {
			const fromHour = date.getUTCHours();
			const fromMinute = date.getUTCMinutes();
			for (const hour of hours) {
				if (hour < fromHour) continue;
				for (const minute of minutes) {
					if (hour === fromHour && minute < fromMinute) continue;
					return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute);
				}
			}
		}
		cursor = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
	}

	throw new InvalidCronError(`no occurrence within ${SEARCH_DAYS} days`);
}

function nextCronAtZoned(spec: CronSpec, afterMs: number, timeZone: string): number {
	const formatter = localFormatter(timeZone);
	const start = localDateTime(formatter, afterMs);
	const startDay = Date.UTC(start.year, start.month - 1, start.day);
	const hours = [...spec.hours].sort((a, b) => a - b);
	const minutes = [...spec.minutes].sort((a, b) => a - b);

	for (let day = 0; day < SEARCH_DAYS; day++) {
		const date = new Date(startDay + day * DAY_MS);
		if (!spec.months.has(date.getUTCMonth() + 1) || !dayMatches(spec, date)) continue;

		for (const hour of hours) {
			if (day === 0 && hour < start.hour) continue;
			for (const minute of minutes) {
				if (day === 0 && hour === start.hour && minute < start.minute) continue;
				const instant = earliestInstant(formatter, {
					year: date.getUTCFullYear(),
					month: date.getUTCMonth() + 1,
					day: date.getUTCDate(),
					hour,
					minute,
					second: 0,
				});
				if (instant !== null && instant > afterMs) return instant;
			}
		}
	}

	throw new InvalidCronError(`no occurrence within ${SEARCH_DAYS} days`);
}

/**
 * `afterMs`より後の最初の一致時刻を返す
 * ちょうど一致する時刻は対象外, 発火直後の再計算での同時刻の反復防止
 */
export function nextCronAt(spec: CronSpec, afterMs: number, timeZone = 'UTC'): number {
	if (timeZone === 'UTC') return nextCronAtUtc(spec, afterMs);
	const resolved = resolveTimeZone(timeZone);
	return resolved === 'UTC' ? nextCronAtUtc(spec, afterMs) : nextCronAtZoned(spec, afterMs, resolved);
}
