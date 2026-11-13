// 5フィールド(分 時 日 月 曜日)を指定タイムゾーンで分精度評価(ADR-0040)
// 記法は数値, `*`, `,`, `-`, `/`のみ, 名前(JAN, MON等)非対応

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
	/** 日と曜日の両方に制限ありでOR判定(標準cron) */
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

// うるう日含む全周期が範囲内に出現
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

function parseRange(text: string, min: number, max: number, label: string): [number, number] {
	if (text === '*') return [min, max];
	const [fromText, toText, ...extra] = text.split('-');
	if (fromText === undefined || extra.length > 0) throw new InvalidCronError(`invalid ${label} range: ${text}`);
	const from = parseValue(fromText, min, max, label);
	const to = toText !== undefined ? parseValue(toText, min, max, label) : from;
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
		const [range, stepText, ...extra] = part.split('/');
		if (range === undefined || extra.length > 0) throw new InvalidCronError(`invalid ${label} step: ${part}`);
		// ステップは範囲と`*`のみ, 単一値は範囲の記述漏れと区別不能
		if (stepText !== undefined && range !== '*' && !range.includes('-')) {
			throw new InvalidCronError(`step requires a range: ${part}`);
		}
		const step = stepText !== undefined ? parseValue(stepText, 1, max - min + 1, `${label} step`) : 1;
		const [from, to] = parseRange(range, min, max, label);
		for (let value = from; value <= to; value += step) values.add(value);
	}
	return values;
}

export function parseCron(expression: string): CronSpec {
	const fields = expression.trim().split(/\s+/);
	const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
	if (
		fields.length !== FIELDS.length ||
		minute === undefined ||
		hour === undefined ||
		dayOfMonth === undefined ||
		month === undefined ||
		dayOfWeek === undefined
	) {
		throw new InvalidCronError(`expected 5 fields (minute hour day month weekday): ${expression}`);
	}

	const parse = (text: string, { label, min, max }: (typeof FIELDS)[number]) => parseField(text, min, max, label);
	const minutes = parse(minute, FIELDS[0]);
	const hours = parse(hour, FIELDS[1]);
	const daysOfMonth = parse(dayOfMonth, FIELDS[2]);
	const months = parse(month, FIELDS[3]);
	// 曜日7は日曜, getUTCDay()の0へ統一
	const daysOfWeek = new Set([...parse(dayOfWeek, FIELDS[4])].map(value => (value === 7 ? 0 : value)));

	return {
		minutes,
		hours,
		daysOfMonth,
		months,
		daysOfWeek,
		restrictedDayOfMonth: !dayOfMonth.startsWith('*'),
		restrictedDayOfWeek: !dayOfWeek.startsWith('*'),
	};
}

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

// 存在しない日時はnull
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

	// 一致日のみ時分を走査, 分単位の全走査は5年で数百万回
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

/** `afterMs`と同時刻は対象外, 発火直後の再計算での重複発火防止 */
export function nextCronAt(spec: CronSpec, afterMs: number, timeZone = 'UTC'): number {
	if (timeZone === 'UTC') return nextCronAtUtc(spec, afterMs);
	const resolved = resolveTimeZone(timeZone);
	return resolved === 'UTC' ? nextCronAtUtc(spec, afterMs) : nextCronAtZoned(spec, afterMs, resolved);
}
