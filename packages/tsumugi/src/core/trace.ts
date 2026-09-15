// W3C Trace Context version 00
export function normalizeTraceparent(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (
		typeof value !== 'string' ||
		value.length !== 55 ||
		!/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(value) ||
		value.slice(3, 35) === '0'.repeat(32) ||
		value.slice(36, 52) === '0'.repeat(16)
	) {
		throw new Error('traceparent must be a valid W3C Trace Context version 00 value');
	}
	return value;
}
