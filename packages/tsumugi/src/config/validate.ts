import { isRemoteRef } from '../core/api.js';
import type { PerformerRegistry } from '../queue/consumer.js';
import type { Flows } from '../core/flow.js';

/**
 * 起動時の設定検証(ADR-0036)
 *
 * bindingの記述漏れはジョブを投入した後の実行時エラーとして現れる
 * 最初の呼び出しで`env`を確認し、不足を貼り付け可能な断片とともに返す
 * wrangler設定そのものは読めず、判定は`env`に見える範囲に限定
 */

/** 不足したbindingの種別, 生成する設定断片の形が種別ごとに違う */
export type BindingKind = 'durable-object' | 'd1' | 'queue' | 'analytics' | 'service';

export type MissingBinding = {
	kind: BindingKind;
	/** wrangler設定に書くbinding名 */
	name: string;
	/** Durable Objectのクラス名, またはservice bindingのentrypointのクラス名 */
	className?: string;
	/** 不足の理由, 存在しないのか形が違うのか */
	reason: 'absent' | 'invalid';
};

/**
 * 検証結果
 * `migrations.ts`の`MigrationStatus`に倣い、判別可能なユニオンで返す
 */
export type ConfigStatus = { ok: true } | { ok: false; missing: MissingBinding[] };

export type ValidateInput = {
	performers: PerformerRegistry<any>;
	flows?: Flows;
	schedules?: Record<string, unknown>;
};

/**
 * 常に必要なbinding, flowを使う構成では`RUN`, scheduleを使う構成では`SCHEDULER`が加わる
 * `TSUMUGI_METRICS`は対象外, 未設定でもメトリクスが書かれないだけで実行は成立(ADR-0036)
 */
const REQUIRED: readonly { name: string; kind: BindingKind; className?: string }[] = [
	{ name: 'JOB_SHARD', kind: 'durable-object', className: 'TsumugiJobShard' },
	{ name: 'TSUMUGI_DB', kind: 'd1' },
	{ name: 'TSUMUGI_QUEUE', kind: 'queue' },
];

const RUN_BINDING = { name: 'RUN', kind: 'durable-object' as const, className: 'TsumugiRun' };

const SCHEDULER_BINDING = { name: 'SCHEDULER', kind: 'durable-object' as const, className: 'TsumugiScheduler' };

const absent = (value: unknown): boolean => value === undefined || value === null;

/** 必須bindingを全て不足として返す, CLIの新規生成が断片の入力に使う(ADR-0036) */
export function requiredAsMissing(withFlows = false, withSchedules = false): MissingBinding[] {
	const required = [...REQUIRED, ...(withFlows ? [RUN_BINDING] : []), ...(withSchedules ? [SCHEDULER_BINDING] : [])];
	return required.map((entry) => ({
		kind: entry.kind,
		name: entry.name,
		reason: 'absent' as const,
		...(entry.className ? { className: entry.className } : {}),
	}));
}

/**
 * `env`と`defineTsumugi`の設定を突き合わせる
 * リモートperformerの検査はconsumerと同じ判定を起動時へ前倒し(ADR-0026)
 */
export function validateConfig(env: Record<string, unknown>, config: ValidateInput): ConfigStatus {
	const missing: MissingBinding[] = [];

	const required = requiredAsMissing(
		Boolean(config.flows && Object.keys(config.flows).length > 0),
		Boolean(config.schedules && Object.keys(config.schedules).length > 0),
	);
	for (const entry of required) {
		if (absent(env[entry.name])) missing.push(entry);
	}

	// 別Workerのperformerはservice bindingで解決, binding名は`performers`のキー(ADR-0037)
	// キーは一意なので同じbindingが二度並ぶことはない
	for (const [name, entry] of Object.entries(config.performers)) {
		if (!isRemoteRef(entry)) continue;
		const service = env[name] as { perform?: unknown } | undefined;
		if (absent(service)) missing.push({ kind: 'service', name, reason: 'absent' });
		// 名前は在るが相手がperformerでない場合, 実行時まで発覚せず同じ扱い
		else if (typeof service?.perform !== 'function') missing.push({ kind: 'service', name, reason: 'invalid' });
	}

	return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

/**
 * 検証結果をisolate単位で再利用(ADR-0036)
 *
 * Workersに起動フックは無く、最初の呼び出しを起動とみなす
 * 成功は永続でキャッシュ, `env`は同じisolateの間は不変
 * 不足はキャッシュなし, 設定の追加後に再デプロイせず自動で復帰
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
