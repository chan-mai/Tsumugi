/**
 * cron式の解釈(ADR-0040)
 *
 * 5フィールド(分 時 日 月 曜日)をUTCの分精度で評価する
 * 対応する記法は数値, `*`, `,`, `-`, `/`のみ, 名前(JAN, MONなど)とタイムゾーンは持たない
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
	/** 日と曜日の両方が絞られている場合はOR判定になる, 標準cronの規則 */
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

/** 探索の上限日数, うるう日を含むどの周期もこの窓に必ず現れる */
const SEARCH_DAYS = 366 * 5;

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
		// ステップは範囲か`*`にのみ付く, 単一値へのステップは範囲の書き漏らしと区別できない
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

	// 曜日の7は0と同じ日曜, 判定はgetUTCDay()の0-6で行う
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

/** 標準cronの規則, 日と曜日の両方が絞られている場合はどちらかが合えばよい */
function dayMatches(spec: CronSpec, date: Date): boolean {
	const domOk = spec.daysOfMonth.has(date.getUTCDate());
	const dowOk = spec.daysOfWeek.has(date.getUTCDay());
	return spec.restrictedDayOfMonth && spec.restrictedDayOfWeek ? domOk || dowOk : domOk && dowOk;
}

/**
 * `afterMs`より後の最初の一致時刻を返す
 * ちょうど一致する時刻は返さない, 発火直後の再計算で同じ時刻を繰り返さないため
 */
export function nextCronAt(spec: CronSpec, afterMs: number): number {
	const hours = [...spec.hours].sort((a, b) => a - b);
	const minutes = [...spec.minutes].sort((a, b) => a - b);

	// 日単位で進めて一致する日だけ時分を走査する, 分単位の全走査は5年窓で数百万回になる
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

	// 2月31日のように到達し得ない組み合わせ, 待っても解決しないので定義の誤りとして返す
	throw new InvalidCronError(`no occurrence within ${SEARCH_DAYS} days`);
}
