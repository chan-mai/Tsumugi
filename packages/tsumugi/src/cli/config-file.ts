import { join } from 'node:path';
import type { CliDeps } from './index.js';

/** wrangler設定の形式, 公式にjsonc(json含む)とtomlの2形態がある */
export type ConfigFormat = 'jsonc' | 'toml';

export type WranglerConfig = { path: string; file: string; format: ConfigFormat };

/** wrangler本体の優先順位に合わせてjson系を先に見る */
const CANDIDATES: readonly { file: string; format: ConfigFormat }[] = [
	{ file: 'wrangler.json', format: 'jsonc' },
	{ file: 'wrangler.jsonc', format: 'jsonc' },
	{ file: 'wrangler.toml', format: 'toml' },
];

export function detectWranglerConfig(deps: CliDeps): WranglerConfig | undefined {
	for (const candidate of CANDIDATES) {
		const path = join(deps.cwd, candidate.file);
		if (deps.fs.exists(path)) return { path, file: candidate.file, format: candidate.format };
	}
	return undefined;
}

/** `start`の`"`に対応する閉じ位置を返す, エスケープは読み飛ばす */
const stringEnd = (content: string, start: number): number => {
	for (let i = start + 1; i < content.length; i += 1) {
		if (content[i] === '\\') i += 1;
		else if (content[i] === '"') return i;
	}
	return content.length;
};

/** 文字列とコメントを読み飛ばしつつ深さを追い, 深さ1のキー`name`の値を返す */
const jsonName = (content: string): string | undefined => {
	let depth = 0;
	for (let i = 0; i < content.length; i += 1) {
		const char = content[i];
		if (char === '/' && content[i + 1] === '/') {
			const end = content.indexOf('\n', i);
			if (end === -1) break;
			i = end;
		} else if (char === '/' && content[i + 1] === '*') {
			const end = content.indexOf('*/', i + 2);
			if (end === -1) break;
			i = end + 1;
		} else if (char === '{' || char === '[') {
			depth += 1;
		} else if (char === '}' || char === ']') {
			depth -= 1;
		} else if (char === '"') {
			const end = stringEnd(content, i);
			if (depth === 1 && content.slice(i + 1, end) === 'name') {
				// 値の文字列と区別するため, 直後の`:`まで見てキーと判定する
				const value = content.slice(end + 1).match(/^\s*:\s*"([^"\\]*)"/);
				if (value?.[1] !== undefined) return value[1];
			}
			i = end;
		}
	}
	return undefined;
};

/** トップレベルのキーはテーブルより前に置かれるため, 最初のテーブルヘッダで打ち切る */
const tomlName = (content: string): string | undefined => {
	for (const line of content.split('\n')) {
		if (/^\s*\[/.test(line)) return undefined;
		const match = line.match(/^\s*name\s*=\s*"([^"]+)"/);
		if (match?.[1] !== undefined) return match[1];
	}
	return undefined;
};

/** 設定からトップレベルの`name`だけを読む, パーサを持ち込まず構造を軽く追うに留める */
export function readWorkerName(content: string, format: ConfigFormat): string | undefined {
	return format === 'toml' ? tomlName(content) : jsonName(content);
}
