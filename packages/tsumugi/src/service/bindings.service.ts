import { shardName } from '../core/ids.js';
import type { Policy } from '../core/types.js';
import { eachShard } from '../do/control.js';
import type { TsumugiJobShard } from '../do/job-shard.js';
import { JobReadRepository, type JobRepository } from '../repository/job.repository.js';
import type { ServiceEnv, ServiceOptions } from './types.js';

export type PolicyOutcome<T> =
	| ({ ok: true; shards: number } & T)
	| { ok: false; reason: 'unknown-binding' }
	| { ok: false; reason: 'partial'; shards: number; failed: number[] };

export type Diagnostics = { shard: number; bindings: Record<string, Awaited<ReturnType<TsumugiJobShard['diagnostics']>>> };

export function createBindingService<Env extends ServiceEnv>(
	{ bindings, shardsOf }: ServiceOptions<Env>,
	repositoryOf: (env: Env) => Pick<JobRepository, 'listBindings'> = (env) => new JobReadRepository(env.TSUMUGI_DB),
) {
	const known = (binding: string) => bindings === undefined || bindings.includes(binding);
	const shardCountOf = (binding: string) => Math.max(1, shardsOf?.(binding) ?? 1);

	return {
		// 登録済みperformerを返却, 投影済みbindingのみでは未実行のものを選択不能
		async list(env: Env): Promise<string[]> {
			if (bindings !== undefined) return [...bindings].sort();
			return repositoryOf(env).listBindings();
		},

		// 既定のshards=1でshard 0を照会, 分割時もshard 0のみ(ADR-0011)
		async diagnostics(env: Env): Promise<Diagnostics> {
			const perBinding = await Promise.all(
				(bindings ?? []).map(async (binding) => {
					const stub = env.JOB_SHARD.get(env.JOB_SHARD.idFromName(shardName(binding, 0)));
					return [binding, await stub.diagnostics()] as const;
				}),
			);
			return { shard: 0, bindings: Object.fromEntries(perBinding) };
		},

		async updatePolicy(env: Env, binding: string, patch: Partial<Policy>): Promise<PolicyOutcome<{ policy: Policy }>> {
			if (!known(binding)) return { ok: false, reason: 'unknown-binding' };
			const shards = shardCountOf(binding);
			const { failed, applied } = await eachShard(env, binding, shards, (stub) => stub.updatePolicy(patch));
			if (failed.length > 0) return { ok: false, reason: 'partial', shards, failed };
			// 全shard同一内容, 先頭の結果を代表として返却
			return { ok: true, shards, policy: applied[0] as Policy };
		},

		// 実行時設定を破棄し静的設定へ復帰(#27), 次回投入の同梱設定で再度有効化(#6)
		async resetPolicy(env: Env, binding: string): Promise<PolicyOutcome<object>> {
			if (!known(binding)) return { ok: false, reason: 'unknown-binding' };
			const shards = shardCountOf(binding);
			const { failed } = await eachShard(env, binding, shards, (stub) => stub.resetPolicy());
			if (failed.length > 0) return { ok: false, reason: 'partial', shards, failed };
			return { ok: true, shards };
		},
	};
}
