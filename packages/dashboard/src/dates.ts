export function toDateInput(value: number | null): string {
	if (value === null) return '';
	const at = new Date(value);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

// 上限は当日終端, 同日選択時の0件防止
export function fromDateInput(text: string, edge: 'start' | 'end'): number | null {
	if (!text) return null;
	const [year, month, day] = text.split('-').map(Number);
	if (year === undefined || month === undefined || day === undefined) return null;
	if (![year, month, day].every(Number.isInteger)) return null;
	return edge === 'start' ? new Date(year, month - 1, day).getTime() : new Date(year, month - 1, day, 23, 59, 59, 999).getTime();
}
