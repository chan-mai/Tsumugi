const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const LETTERS = 26;
const LENGTH = 24;

// 先頭英小文字, 以降英小文字と数字
export function createLocalId(): string {
	const chars: string[] = [];
	while (chars.length < LENGTH) {
		for (const byte of crypto.getRandomValues(new Uint8Array(LENGTH * 2))) {
			const range = chars.length === 0 ? LETTERS : ALPHABET.length;
			// 剰余の偏り回避
			if (byte >= 256 - (256 % range)) continue;
			chars.push(ALPHABET[byte % range]!);
			if (chars.length === LENGTH) break;
		}
	}
	return chars.join('');
}
