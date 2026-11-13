export function toDateInput(value: number | null): string {
	if (value === null) return '';
	return Temporal.Instant.fromEpochMilliseconds(value).toZonedDateTimeISO(Temporal.Now.timeZoneId()).toPlainDate().toString();
}

// 上限は当日終端, 同日選択時の0件防止
export function fromDateInput(text: string, edge: 'start' | 'end'): number | null {
	if (!text) return null;
	const parts = text.split('-').map(Number);
	if (parts.length < 3) return null;
	const [year, month, day] = parts;
	if (![year, month, day].every(Number.isInteger)) return null;
	const date = Temporal.PlainDate.from({ year, month, day });
	const timeZone = Temporal.Now.timeZoneId();
	if (edge === 'start') return date.toZonedDateTime(timeZone).epochMilliseconds;
	return date.add({ days: 1 }).toZonedDateTime(timeZone).epochMilliseconds - 1;
}
