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

/** 設定から`name`だけを読む, パーサを持ち込まずregexに留める */
export function readWorkerName(content: string, format: ConfigFormat): string | undefined {
	const match = format === 'toml' ? content.match(/^\s*name\s*=\s*"([^"]+)"/m) : content.match(/"name"\s*:\s*"([^"]+)"/);
	return match?.[1];
}
