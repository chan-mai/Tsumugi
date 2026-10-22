import { isRemoteRef } from '../core/api.js';
import type { PerformerRegistry } from '../queue/consumer.js';
import type { Flows } from '../core/flow.js';

export type BindingKind = 'durable-object' | 'd1' | 'queue' | 'analytics' | 'service';

export type MissingBinding = {
	kind: BindingKind;
	name: string;
	/** Durable Objectのクラス名, またはservice bindingのentrypointのクラス名 */
	className?: string;
	reason: 'absent' | 'invalid';
};

type ConfigStatus = { ok: true } | { ok: false; missing: MissingBinding[] };

type ValidateInput = {
	performers: PerformerRegistry<any>;
	flows?: Flows;
	schedules?: Record<string, unknown>;
};

// `TSUMUGI_METRICS`は未設定でも実行可能で対象外(ADR-0036)
const REQUIRED: readonly { name: string; kind: BindingKind; className?: string }[] = [
	{ name: 'JOB_SHARD', kind: 'durable-object', className: 'TsumugiJobShard' },
	{ name: 'TSUMUGI_DB', kind: 'd1' },
	{ name: 'TSUMUGI_QUEUE', kind: 'queue' },
];

const RUN_BINDING = { name: 'RUN', kind: 'durable-object' as const, className: 'TsumugiRun' };

const SCHEDULER_BINDING = { name: 'SCHEDULER', kind: 'durable-object' as const, className: 'TsumugiScheduler' };

const absent = (value: unknown): boolean => value === undefined || value === null;

/** CLIの新規生成の断片入力用(ADR-0036) */
export function requiredAsMissing(withFlows = false, withSchedules = false): MissingBinding[] {
	const required = [...REQUIRED, ...(withFlows ? [RUN_BINDING] : []), ...(withSchedules ? [SCHEDULER_BINDING] : [])];
	return required.map((entry) => ({
		kind: entry.kind,
		name: entry.name,
		reason: 'absent' as const,
		...(entry.className ? { className: entry.className } : {}),
	}));
}

/** リモートperformerはconsumerと同判定を起動時に実施(ADR-0026) */
export function validateConfig(env: Record<string, unknown>, config: ValidateInput): ConfigStatus {
	const missing: MissingBinding[] = [];

	const required = requiredAsMissing(
		Boolean(config.flows && Object.keys(config.flows).length > 0),
		Boolean(config.schedules && Object.keys(config.schedules).length > 0),
	);
	for (const entry of required) {
		if (absent(env[entry.name])) missing.push(entry);
	}

	// 別Workerのperformerはservice binding, binding名は`performers`のキー(ADR-0037)
	for (const [name, entry] of Object.entries(config.performers)) {
		if (!isRemoteRef(entry)) continue;
		const service = env[name] as { perform?: unknown } | undefined;
		if (absent(service)) missing.push({ kind: 'service', name, reason: 'absent' });
		// 非performerも実行時まで未発覚, 不足扱い
		else if (typeof service?.perform !== 'function') missing.push({ kind: 'service', name, reason: 'invalid' });
	}

	return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

/**
 * 検証結果のisolate単位キャッシュ, `env`はisolate内で不変(ADR-0036)
 * 不足は非キャッシュ, 設定追加後に再デプロイ無しで復帰
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
