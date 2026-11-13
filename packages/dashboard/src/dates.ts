export function toDateInput(value: number | null): string {
	if (value === null) return '';
	return Temporal.Instant.fromEpochMilliseconds(value).toZonedDateTimeISO(Temporal.Now.timeZoneId()).toPlainDate().toString();
}

// 上限は当日終端, 同日選択時の0件防止
export function fromDateInput(text: string, edge: 'start' | 'end'): number | null {
	if (!text) return null;
	const [year, month, day] = text.split('-').map(Number);
	if (year === undefined || month === undefined || day === undefined) return null;
	if (![year, month, day].every(Number.isInteger)) return null;
	const start = Temporal.PlainDate.from({ year, month, day }).toZonedDateTime(Temporal.Now.timeZoneId());
	return edge === 'start' ? start.epochMilliseconds : start.add({ days: 1 }).epochMilliseconds - 1;
}
