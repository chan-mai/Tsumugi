import { InvalidJobIdError } from './ids.js';

/**
 * FNV-1a, 短い実装で分布十分, 外部依存不要(ADR-0011)
 * ハッシュ変更で既存ジョブの配置先が変化, 公開後変更不可
 */
export function hashToShard(partitionKey: string, shards: number): number {
	if (shards <= 1) return 0;
	let hash = 0x811c9dc5;
	for (let i = 0; i < partitionKey.length; i++) {
		hash ^= partitionKey.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash % shards;
}

/**
 * 分割構成でpartitionKey省略時はエラー(ADR-0011)
 * 0番への暗黙割当はキー単位制御と重複排除を警告なく無効化
 */
export function resolveShard(binding: string, shards: number, partitionKey: string | undefined): number {
	if (shards <= 1) return 0;
	if (partitionKey === undefined) {
		throw new InvalidJobIdError(
			`${binding} is split into shards=${shards} and requires partitionKey, omitting it drops the per-key guarantees`,
		);
	}
	return hashToShard(partitionKey, shards);
}
