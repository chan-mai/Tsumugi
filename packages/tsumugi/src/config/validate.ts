import { isRemoteRef } from '../core/api.js';
import type { PerformerRegistry } from '../queue/consumer.js';
import type { Flows } from '../core/flow.js';

/**
 * 起動時の設定検証(ADR-0036)
 *
 * bindingの記述漏れはジョブを投入した後の実行時エラーとして現れる
 * 最初の呼び出しで`env`を見て,不足を貼り付けられる断片とともに返す
 * wrangler設定そのものは読めないので,判定は`env`に見える範囲に限る
 */

/** 不足したbindingの種別, 生成する設定断片の形が種別ごとに違う */
export type BindingKind = 'durable-object' | 'd1' | 'queue' | 'analytics' | 'service';

export type MissingBinding = {
	kind: BindingKind;
	/** wrangler設定に書くbinding名 */
	name: string;
	/** Durable Objectのクラス名, 種別がdurable-objectの場合のみ */
	className?: string;
	/** 不足の理由, 存在しないのか形が違うのか */
	reason: 'absent' | 'invalid';
};

/**
 * 検証結果
 * `migrations.ts`の`MigrationStatus`に倣い,判別可能なユニオンで返す
 */
export type ConfigStatus = { ok: true } | { ok: false; missing: MissingBinding[] };

export type ValidateInput = {
	performers: PerformerRegistry<any>;
	flows?: Flows;
};

/**
 * 常に要るbinding, flowを使う構成では`RUN`が加わる
 * `TSUMUGI_METRICS`は含めない, 未設定でもメトリクスが書かれないだけで実行は成立する(ADR-0036)
 */
const REQUIRED: readonly { name: string; kind: BindingKind; className?: string }[] = [
	{ name: 'JOB_SHARD', kind: 'durable-object', className: 'TsumugiJobShard' },
	{ name: 'TSUMUGI_DB', kind: 'd1' },
	{ name: 'TSUMUGI_QUEUE', kind: 'queue' },
];

const RUN_BINDING = { name: 'RUN', kind: 'durable-object' as const, className: 'TsumugiRun' };

const absent = (value: unknown): boolean => value === undefined || value === null;

/**
 * `env`と`defineTsumugi`の設定を突き合わせる
 * リモートperformerの検査はconsumerと同じ判定を起動時へ前倒しする(ADR-0026)
 */
export function validateConfig(env: Record<string, unknown>, config: ValidateInput): ConfigStatus {
	const missing: MissingBinding[] = [];

	const required = [...REQUIRED, ...(config.flows && Object.keys(config.flows).length > 0 ? [RUN_BINDING] : [])];
	for (const entry of required) {
		if (absent(env[entry.name])) {
			missing.push({ kind: entry.kind, name: entry.name, reason: 'absent', ...(entry.className ? { className: entry.className } : {}) });
		}
	}

	// 別Workerのperformerはservice bindingで解決する, binding名は`performers`のキー(ADR-0037)
	for (const [name, entry] of Object.entries(config.performers)) {
		if (!isRemoteRef(entry)) continue;
		const service = env[name] as { perform?: unknown } | undefined;
		if (absent(service)) missing.push({ kind: 'service', name, reason: 'absent' });
		// 名前は在るが相手がperformerでない場合, 実行時まで気付けないので同じ扱いにする
		else if (typeof service?.perform !== 'function') missing.push({ kind: 'service', name, reason: 'invalid' });
	}

	return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

/**
 * 検証結果をisolate単位で使い回す(ADR-0036)
 *
 * Workersに起動フックは無いので,最初の呼び出しを起動とみなす
 * 成功は永続でキャッシュする, `env`は同じisolateの間は変わらない
 * 不足はキャッシュしない, 設定を足した後に再デプロイせず自力で復帰させる
 */
export function cachedValidate(config: ValidateInput): (env: Record<string, unknown>) => ConfigStatus {
	let settled: ConfigStatus | undefined;

	return (env) => {
		if (settled?.ok) return settled;
		const status = validateConfig(env, config);
		if (status.ok) settled = status;
		return status;
	};
}
