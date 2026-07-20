import { InvalidJobIdError } from './ids.js';

/**
 * partitionKeyからshard番号を決める(ADR-0011)
 *
 * FNV-1a,実装が短く分布も十分で外部依存が要らない
 * ハッシュを変えると既存ジョブの居場所が変わるので,一度公開したら変更しない
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
 * 分割している場合にpartitionKeyが無いと,キー単位の制御も重複排除も静かに破れる
 * 黙って0番に落とさず明示的に拒否する(ADR-0011)
 */
export function resolveShard(binding: string, shards: number, partitionKey: string | undefined): number {
	if (shards <= 1) return 0;
	if (partitionKey === undefined) {
		throw new InvalidJobIdError(`${binding}はshards=${shards}で分割されているためpartitionKeyが必須,省略するとキー単位の保証が失われる`);
	}
	return hashToShard(partitionKey, shards);
}
