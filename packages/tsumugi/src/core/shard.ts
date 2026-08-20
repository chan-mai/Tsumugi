import { InvalidJobIdError } from './ids.js';

/**
 * partitionKeyからshard番号を決める(ADR-0011)
 *
 * FNV-1a, 実装が短く分布も十分で外部依存が不要
 * ハッシュを変えると既存ジョブの配置先が変わる, 一度公開したら変更不可
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
 * 投入先のshardを決める
 * 分割構成でpartitionKeyが無いと、キー単位の制御も重複排除も警告なく無効化
 * 0番への暗黙の割り当てはせず、明示的に拒否(ADR-0011)
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
