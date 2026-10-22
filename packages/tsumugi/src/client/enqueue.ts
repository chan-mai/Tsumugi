import { shardName } from '../core/ids.js';
import { resolveShard } from '../core/shard.js';
import { normalizeTraceparent } from '../core/trace.js';
import type { Policy, SettledTarget } from '../core/types.js';
import type { EnqueueInput, ShardSettings } from '../do/job-shard.js';

/** DO呼び出しRPCの型宣言のみ, DOクラス非参照でenqueue専用WorkerにDO実装不要(ADR-0023) */
export interface JobShardStub extends Rpc.DurableObjectBranded {
	enqueueMany(inputs: readonly EnqueueInput[], settings?: ShardSettings): Promise<string[]>;
}

/**
 * `DurableObjectNamespace<T>`はTに不変でDO本体の型は`JobShardStub`へ代入不可
 * 引数型を広げ`shardOf`の1箇所で限定, 利用者のEnvをそのまま利用可能
 */
export type ClientEnv = {
	JOB_SHARD: DurableObjectNamespace<any>;
};

export type BindingConfig = {
	/**
	 * 分割数, 既定1
	 * 2以上でpartitionKey必須, キー単位の保証はpartition内に限定(ADR-0011)
	 */
	shards?: number;
	/** 流量制御とエージング(ADR-0009 / ADR-0045 / ADR-0020) */
	policy?: Partial<Policy>;
	/** 完了ジョブ(COMPLETED / CANCELLED)のDO保持時間, 既定5分, 明細はD1へ投影済み */
	sweepAfterMs?: number;
	/** 失敗ジョブ(FAILED / STALLED)のDO保持時間, 既定7日, 手動リトライ受付期間でD1保持と同一(ADR-0027) */
	failedRetentionMs?: number;
};

export type TsumugiClient<Env extends ClientEnv> = {
	enqueue(env: Env, input: EnqueueInput): Promise<string>;
	enqueueMany(env: Env, inputs: readonly EnqueueInput[]): Promise<string[]>;
	shardFor(env: Env, binding: string, partitionKey?: string): DurableObjectStub<JobShardStub>;
};

export const configOf = (bindings: Record<string, BindingConfig>, binding: string): BindingConfig | undefined =>
	Object.hasOwn(bindings, binding) ? bindings[binding] : undefined;

function settingsOf(config: BindingConfig | undefined, common: CommonSettings): ShardSettings | undefined {
	const hasBinding = config?.policy || config?.sweepAfterMs !== undefined || config?.failedRetentionMs !== undefined;
	if (!hasBinding && common.failureBinding === undefined && common.settled === undefined) return undefined;
	return {
		...(config?.policy ? { policy: config.policy } : {}),
		...(config?.sweepAfterMs !== undefined ? { sweepAfterMs: config.sweepAfterMs } : {}),
		...(config?.failedRetentionMs !== undefined ? { failedRetentionMs: config.failedRetentionMs } : {}),
		...(common.failureBinding !== undefined ? { failureBinding: common.failureBinding } : {}),
		...(common.settled !== undefined ? { settled: common.settled } : {}),
	};
}

/** 毎投入で同梱 */
export type CommonSettings = {
	/**
	 * 失敗通知先binding(#30), nullは解除, 省略はDOの現行値維持
	 * 宛先を持たない経路からの省略と解除の区別用
	 */
	failureBinding?: string | null;
	/** 終端通知の宛先と対象, nullは解除, 省略はDOの現行値維持(#96) */
	settled?: SettledTarget | null;
};

const DEFAULTABLE_KEYS = [
	'traceparent',
	'priority',
	'maxAttempts',
	'backoff',
	'timeoutMs',
	'guarantee',
	'delayMs',
	'runAt',
	'expiresAt',
	'expiresInMs',
	'concurrencyKey',
] as const;

export type EnqueueDefaults = Partial<Pick<EnqueueInput, (typeof DEFAULTABLE_KEYS)[number]>>;

/** 投入時の既定値付与フック, 呼び出し側未指定のキーのみ適用(#96) */
export type EnqueueHook = (input: Readonly<EnqueueInput>) => EnqueueDefaults | undefined;

// 片方確定時はもう片方の既定値破棄
const EXCLUSIVE_PAIRS: readonly (readonly [keyof EnqueueDefaults, keyof EnqueueDefaults])[] = [
	['delayMs', 'runAt'],
	['expiresAt', 'expiresInMs'],
];

function applyDefaults(input: EnqueueInput, defaults: EnqueueDefaults | undefined): EnqueueInput {
	if (!defaults) return input;
	const merged: EnqueueInput = { ...input };
	const blocked = new Set<keyof EnqueueDefaults>();
	for (const [a, b] of EXCLUSIVE_PAIRS) {
		if (input[a] !== undefined || input[b] !== undefined) {
			blocked.add(a);
			blocked.add(b);
		}
	}
	for (const key of DEFAULTABLE_KEYS) {
		if (blocked.has(key)) continue;
		const value = defaults[key];
		if (value === undefined || merged[key] !== undefined) continue;
		(merged as Record<string, unknown>)[key] = value;
		for (const [a, b] of EXCLUSIVE_PAIRS) {
			if (key === a) blocked.add(b);
			if (key === b) blocked.add(a);
		}
	}
	return merged;
}

/** ジョブ管理Worker本体と別Workerで共通経路 */
export function createClient<Env extends ClientEnv>(
	bindings: Record<string, BindingConfig> = {},
	common: CommonSettings = {},
	hooks: { onEnqueue?: EnqueueHook } = {},
): TsumugiClient<Env> {
	const shardOf = (env: Env, binding: string, partitionKey: string | undefined) => {
		const config = configOf(bindings, binding);
		const shard = resolveShard(binding, config?.shards ?? 1, partitionKey);
		const ns = env.JOB_SHARD as DurableObjectNamespace<JobShardStub>;
		return {
			stub: ns.get(ns.idFromName(shardName(binding, shard))),
			settings: settingsOf(config, common),
		};
	};

	async function enqueueMany(env: Env, rawInputs: readonly EnqueueInput[]): Promise<string[]> {
		// フックは宛先解決前に適用, traceparent検証はフック付与分含む
		const onEnqueue = hooks.onEnqueue;
		const inputs = onEnqueue ? rawInputs.map((input) => applyDefaults(input, onEnqueue(input))) : rawInputs;
		for (const input of inputs) normalizeTraceparent(input.traceparent);
		// 宛先DOごとに集約, 個別RPCはDOの1,000 req/sソフト上限で律速
		type Group = { stub: DurableObjectStub<JobShardStub>; settings: ShardSettings | undefined; items: EnqueueInput[] };
		const groups = new Map<string, Group>();
		const order: string[] = [];

		for (const input of inputs) {
			const { stub, settings } = shardOf(env, input.binding, input.partitionKey);
			const key = stub.id.toString();
			const group = groups.get(key) ?? { stub, settings, items: [] };
			group.items.push(input);
			groups.set(key, group);
			order.push(key);
		}

		const results = new Map<string, string[]>();
		await Promise.all(
			[...groups.entries()].map(async ([key, group]) => {
				results.set(key, await group.stub.enqueueMany(group.items, group.settings));
			}),
		);

		const cursor = new Map<string, number>();
		return order.map((key) => {
			const at = cursor.get(key) ?? 0;
			cursor.set(key, at + 1);
			return results.get(key)?.[at] as string;
		});
	}

	return {
		enqueueMany,
		async enqueue(env, input) {
			const [id] = await enqueueMany(env, [input]);
			return id as string;
		},
		shardFor(env, binding, partitionKey) {
			return shardOf(env, binding, partitionKey).stub;
		},
	};
}
