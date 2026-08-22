const BROWSER_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

type ZonedFormatters = {
	local: Intl.DateTimeFormat;
	offset: Intl.DateTimeFormat;
	timeZone: string;
};

const formatters = new Map<string, ZonedFormatters>();

export const browserTimeZone = (): string => BROWSER_TIME_ZONE;

function formattersFor(timeZone: string): ZonedFormatters {
	const cached = formatters.get(timeZone);
	if (cached) return cached;

	const local = new Intl.DateTimeFormat(undefined, {
		timeZone,
		year: 'numeric',
		month: 'numeric',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
		second: '2-digit',
	});
	const resolved = local.resolvedOptions().timeZone;
	const created = {
		local,
		offset: new Intl.DateTimeFormat('en-US', { timeZone: resolved, timeZoneName: 'longOffset' }),
		timeZone: resolved,
	};
	formatters.set(timeZone, created);
	return created;
}

export function formatTimestamp(value: number, timeZone = BROWSER_TIME_ZONE): string {
	const formatter = formattersFor(timeZone);
	const instant = new Date(value);
	const part = formatter.offset.formatToParts(instant).find((entry) => entry.type === 'timeZoneName')?.value;
	const offset = part === 'GMT' || part === 'UTC' ? 'GMT+00:00' : (part ?? 'GMT+00:00');
	return `${formatter.local.format(instant)} ${offset} [${formatter.timeZone}]`;
}
