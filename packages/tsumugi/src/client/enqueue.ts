import { shardName } from '../core/ids.js';
import { resolveShard } from '../core/shard.js';
import { normalizeTraceparent } from '../core/trace.js';
import type { Policy, SettledTarget } from '../core/types.js';
import type { EnqueueInput, ShardSettings } from '../do/job-shard.js';

/**
 * DOに投げるRPCの形だけの宣言
 * DOクラス非参照によりenqueue専用WorkerにDO実装が不要(ADR-0023)
 */
export interface JobShardStub extends Rpc.DurableObjectBranded {
	enqueueMany(inputs: readonly EnqueueInput[], settings?: ShardSettings): Promise<string[]>;
}

/**
 * `DurableObjectNamespace<T>`はTに不変, DO本体の型は`JobShardStub`に代入不可
 * 受け口の型を広げ`shardOf`の1箇所で限定, 利用者は自分のEnvをそのまま渡せる
 */
export type ClientEnv = {
	JOB_SHARD: DurableObjectNamespace<any>;
};

export type BindingConfig = {
	/**
	 * 分割数,既定は1
	 * 2以上にするとpartitionKeyが必須になり、キー単位の保証はpartition内に限定(ADR-0011)
	 */
	shards?: number;
	/** 流量制御とエージング(ADR-0009 / ADR-0045 / ADR-0020) */
	policy?: Partial<Policy>;
	/**
	 * 済んだジョブ(COMPLETED / CANCELLED)をDOに残す時間,既定5分
	 * 明細はD1へ投影済みでDOに残す理由が無い
	 */
	sweepAfterMs?: number;
	/**
	 * 失敗ジョブ(FAILED / STALLED)をDOに残す時間,既定7日
	 * 手動リトライを受け付ける期間, D1の保持と揃えてある(ADR-0027)
	 */
	failedRetentionMs?: number;
};

export type TsumugiClient<Env extends ClientEnv> = {
	enqueue(env: Env, input: EnqueueInput): Promise<string>;
	enqueueMany(env: Env, inputs: readonly EnqueueInput[]): Promise<string[]>;
	shardFor(env: Env, binding: string, partitionKey?: string): DurableObjectStub<JobShardStub>;
};

export const configOf = (bindings: Record<string, BindingConfig>, binding: string): BindingConfig | undefined =>
	Object.hasOwn(bindings, binding) ? bindings[binding] : undefined;

/** binding個別の設定と全体で共通の設定を1つにまとめる, DOへ渡る形は1つ */
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

/** bindingを問わず同じ値を渡す設定, 投入のたびに同梱して届ける */
export type CommonSettings = {
	/**
	 * 失敗を知らせる先のbinding(#30)
	 * nullは解除, 省略はDOが今持つ宛先を変えない
	 * 宛先を持たない経路からも省略が届き、未指定と解除を区別
	 */
	failureBinding?: string | null;
	/**
	 * 終端を知らせる宛先と対象(#96)
	 * nullは解除, 省略はDOが今持つ値を変えない
	 */
	settled?: SettledTarget | null;
};

/** onEnqueueで付与できる実行オプション, 宛先と識別子は対象外 */
export type EnqueueDefaults = Partial<
	Pick<
		EnqueueInput,
		| 'traceparent'
		| 'priority'
		| 'maxAttempts'
		| 'backoff'
		| 'timeoutMs'
		| 'guarantee'
		| 'delayMs'
		| 'runAt'
		| 'expiresAt'
		| 'expiresInMs'
		| 'concurrencyKey'
	>
>;

/**
 * 投入のたびに既定値を付与するフック(#96)
 * 返した値のうち呼び出し側が明示していないキーのみ適用
 */
export type EnqueueHook = (input: Readonly<EnqueueInput>) => EnqueueDefaults | undefined;

/** フックが付与できるキーの列挙, 戻り値に紛れた対象外のキーは無視 */
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

/** 排他のオプションの組, 片方が決まればもう片方の既定値は破棄 */
const EXCLUSIVE_PAIRS: readonly (readonly [keyof EnqueueDefaults, keyof EnqueueDefaults])[] = [
	['delayMs', 'runAt'],
	['expiresAt', 'expiresInMs'],
];

/** 既定値の適用, 明示値が優先でundefinedのキーだけを補完 */
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

/**
 * 投入専用のクライアント
 * ジョブ管理Worker本体と別Workerからのenqueueで同一経路
 */
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
		// フックは宛先解決より前に適用, traceparentの検証もフックの付与分を含めて実施
		const onEnqueue = hooks.onEnqueue;
		const inputs = onEnqueue ? rawInputs.map((input) => applyDefaults(input, onEnqueue(input))) : rawInputs;
		for (const input of inputs) normalizeTraceparent(input.traceparent);
		// 宛先DOごとの集約, 逐次の個別RPCはDOの1,000 req/sソフト上限が律速
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

		// 入力の並び順に戻す
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
