// Queuesの上限, 1KBは1000バイト換算
const MESSAGE_MAX_BYTES = 128_000;
const BATCH_MAX_BYTES = 256_000;
const BATCH_MAX_COUNT = 100;
// メッセージ毎の内部メタデータ, 上限に算入
const METADATA_BYTES = 100;

/** 残りはメッセージの他項目と直列化形式の差の余裕 */
export const PAYLOAD_MAX_BYTES = 120_000;

export class PayloadTooLargeError extends Error {
	constructor(readonly bytes: number) {
		super(`payload is too large: ${bytes} bytes as JSON, the limit is ${PAYLOAD_MAX_BYTES}`);
		this.name = 'PayloadTooLargeError';
	}
}

const encoder = new TextEncoder();

export const jsonBytes = (value: unknown): number => encoder.encode(JSON.stringify(value) ?? '').byteLength;

export function assertPayloadSize(payload: unknown): void {
	const bytes = jsonBytes(payload);
	if (bytes > PAYLOAD_MAX_BYTES) throw new PayloadTooLargeError(bytes);
}

/** 単独で上限超過のメッセージは送信不能, oversizedへ分離 */
export function splitBatches<T>(bodies: readonly T[]): { batches: T[][]; oversized: T[] } {
	const batches: T[][] = [];
	const oversized: T[] = [];
	let current: T[] = [];
	let bytes = 0;
	for (const body of bodies) {
		const size = jsonBytes(body) + METADATA_BYTES;
		if (size > MESSAGE_MAX_BYTES) {
			oversized.push(body);
			continue;
		}
		if (current.length >= BATCH_MAX_COUNT || bytes + size > BATCH_MAX_BYTES) {
			batches.push(current);
			current = [];
			bytes = 0;
		}
		current.push(body);
		bytes += size;
	}
	if (current.length > 0) batches.push(current);
	return { batches, oversized };
}
