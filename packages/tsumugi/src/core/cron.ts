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

// うるう日含む全周期が範囲内に出現
const SEARCH_DAYS = 366 * 5;

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
		// ステップは範囲と`*`のみ, 単一値は範囲の記述漏れと区別不能
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

	// 曜日7は日曜, 0へ統一
	const daysOfWeek = new Set([...parsed[4]!].map((value) => (value === 7 ? 0 : value)));

	return {
		minutes: parsed[0]!,
		hours: parsed[1]!,
		daysOfMonth: parsed[2]!,
		months: parsed[3]!,
		daysOfWeek,
		restrictedDayOfMonth: !fields[2]!.startsWith('*'),
		restrictedDayOfWeek: !fields[4]!.startsWith('*'),
	};
}

function dayMatches(spec: CronSpec, date: Temporal.PlainDate): boolean {
	const domOk = spec.daysOfMonth.has(date.day);
	const dowOk = spec.daysOfWeek.has(date.dayOfWeek % 7);
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

const plainDateTimeOf = (instant: number, timeZone: string): Temporal.PlainDateTime =>
	Temporal.Instant.fromEpochMilliseconds(instant).toZonedDateTimeISO(timeZone).toPlainDateTime();

function nextCronAtUtc(spec: CronSpec, afterMs: number): number {
	const hours = [...spec.hours].sort((a, b) => a - b);
	const minutes = [...spec.minutes].sort((a, b) => a - b);

	// 一致日のみ時分を走査, 分単位の全走査は5年で数百万回
	let cursor = plainDateTimeOf(Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS, 'UTC');
	for (let day = 0; day < SEARCH_DAYS; day++) {
		const date = cursor.toPlainDate();
		if (spec.months.has(date.month) && dayMatches(spec, date)) {
			for (const hour of hours) {
				if (hour < cursor.hour) continue;
				for (const minute of minutes) {
					if (hour === cursor.hour && minute < cursor.minute) continue;
					return date.toZonedDateTime({ timeZone: 'UTC', plainTime: { hour, minute } }).epochMilliseconds;
				}
			}
		}
		cursor = date.add({ days: 1 }).toPlainDateTime();
	}

	throw new InvalidCronError(`no occurrence within ${SEARCH_DAYS} days`);
}

function nextCronAtZoned(spec: CronSpec, afterMs: number, timeZone: string): number {
	const start = plainDateTimeOf(afterMs, timeZone);
	const hours = [...spec.hours].sort((a, b) => a - b);
	const minutes = [...spec.minutes].sort((a, b) => a - b);

	for (let day = 0; day < SEARCH_DAYS; day++) {
		const date = start.toPlainDate().add({ days: day });
		if (!spec.months.has(date.month) || !dayMatches(spec, date)) continue;

		for (const hour of hours) {
			if (day === 0 && hour < start.hour) continue;
			for (const minute of minutes) {
				if (day === 0 && hour === start.hour && minute < start.minute) continue;
				const target = date.toPlainDateTime({ hour, minute });
				// 重複する日時は早い方, 存在しない日時は対象外
				const zoned = target.toZonedDateTime(timeZone, { disambiguation: 'earlier' });
				if (!zoned.toPlainDateTime().equals(target)) continue;
				if (zoned.epochMilliseconds > afterMs) return zoned.epochMilliseconds;
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
