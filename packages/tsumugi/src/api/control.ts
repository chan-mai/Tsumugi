import { shardName, shardNameOf } from '../core/ids.js';
import type { BulkFailure, MutationResult, TsumugiJobShard } from '../do/job-shard.js';
import type { ConsumerEnv } from '../queue/consumer.js';

// 変更は正であるDOへ送信, 読み取りモデルは正でない(ADR-0008)

type ShardEnv = Pick<ConsumerEnv, 'JOB_SHARD'>;
type ShardStub = DurableObjectStub<TsumugiJobShard>;

/** ジョブID不正時はInvalidJobIdError */
export function mutateJob(env: ShardEnv, jobId: string, apply: (stub: ShardStub) => Promise<MutationResult>): Promise<MutationResult> {
	return apply(env.JOB_SHARD.get(env.JOB_SHARD.idFromName(shardNameOf(jobId))));
}

/** 1件ずつの送信はDOへの往復が件数分増加 */
export function groupByShard(jobIds: readonly string[]): { groups: Map<string, string[]>; invalid: string[] } {
	const groups = new Map<string, string[]>();
	const invalid: string[] = [];

	for (const jobId of jobIds) {
		let name: string;
		try {
			name = shardNameOf(jobId);
		} catch {
			// 読み取りモデル行の破損時は中断せずinvalidへ記録
			invalid.push(jobId);
			continue;
		}
		const bucket = groups.get(name);
		if (bucket) bucket.push(jobId);
		else groups.set(name, [jobId]);
	}
	return { groups, invalid };
}

export type BulkOutcome = {
	ok: string[];
	failed: (BulkFailure | { id: string; reason: 'invalid-id' | 'unreachable' })[];
};

// 数秒の遅延考慮で状態判定はDO側で再実施, 不一致分は理由付きで返却
// 到達不能shardも個別失敗として返却, 全体失敗では成功分も再送発生
export async function mutateJobs(env: ShardEnv, action: 'retry' | 'cancel', jobIds: readonly string[]): Promise<BulkOutcome> {
	const { groups, invalid } = groupByShard(jobIds);
	const entries = [...groups];
	const settled = await Promise.allSettled(
		entries.map(([name, ids]) => env.JOB_SHARD.get(env.JOB_SHARD.idFromName(name)).mutateMany(action, ids)),
	);
	for (const [index, result] of settled.entries()) {
		if (result.status === 'rejected') console.error(`tsumugi: bulk ${action} failed on ${entries[index]?.[0]}`, result.reason);
	}

	const applied = settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
	const unreachable = settled.flatMap((result, index) =>
		result.status === 'rejected' ? (entries[index]?.[1] ?? []).map((id) => ({ id, reason: 'unreachable' as const })) : [],
	);

	return {
		ok: applied.flatMap((result) => result.ok),
		failed: [
			...applied.flatMap((result) => result.failed),
			...invalid.map((id) => ({ id, reason: 'invalid-id' as const })),
			...unreachable,
		],
	};
}

// 分割時は全shardへ同一設定を送信, 1shardでも未反映なら投入継続(ADR-0011)
// 中断せず全shardへ試行, 未到達shardは呼び出し側へ返却し再試行
export async function eachShard<T>(
	env: ShardEnv,
	binding: string,
	shards: number,
	run: (stub: ShardStub) => Promise<T>,
): Promise<{ failed: number[]; applied: T[] }> {
	const stubs = Array.from({ length: shards }, (_, shard) => env.JOB_SHARD.get(env.JOB_SHARD.idFromName(shardName(binding, shard))));
	const settled = await Promise.allSettled(stubs.map(run));
	const failed = settled.flatMap((result, shard) => (result.status === 'rejected' ? [shard] : []));
	for (const [shard, result] of settled.entries()) {
		if (result.status === 'rejected') console.error(`tsumugi: policy update failed on ${shardName(binding, shard)}`, result.reason);
	}
	const applied = settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
	return { failed, applied };
}
