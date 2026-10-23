import type { MetricsResolver } from '../analytics/reader.js';
import type { ConsumerEnv } from '../queue/consumer.js';
import type { RunControlStub, SchedulerControl, StartOptions } from '../do/control.js';
import type { CreateJobInput } from './inputs.js';

export type ServiceEnv = ConsumerEnv & { TSUMUGI_DB: D1Database };

export type ServiceOptions<Env extends ServiceEnv> = {
	// 投入先の検証, 選択肢用, 省略時は検証なし
	bindings?: readonly string[];
	// 流量設定変更は全shardへ送信(#27)
	shardsOf?: (binding: string) => number;
	enqueue?: (env: Env, input: CreateJobInput) => Promise<string>;
	// binding毎の失敗ジョブ保持期間, 一覧`retryable`の事前判定用(ADR-0027)
	failedRetentionMs?: (binding: string) => number;
	// 失敗runの保持期間, 詳細`retryable`判定用(ADR-0034)
	runFailedRetentionMs?: number;
	// 開始先の検証, 選択肢用, 省略時は検証なし
	flows?: readonly string[];
	start?: (env: Env, flow: string, input: unknown, options?: StartOptions) => Promise<string>;
	// 取り消し, 再開はDOへ直接送信, 読み取りモデルは正でない(ADR-0015)
	runFor?: (env: Env, runId: string) => Pick<RunControlStub, 'cancel' | 'retry'>;
	// 定期実行の照会, 操作, Scheduler DOへ直接送信(ADR-0040), 未設定時`/api/schedules`は501
	schedulerFor?: (env: Env) => Pick<SchedulerControl, 'list' | 'setPaused' | 'trigger'>;
	// 未設定時`/api/metrics`は501
	metrics?: MetricsResolver<Env>;
};

export type Unavailable = { ok: false; reason: 'unavailable' };

export type MutationOutcome = { ok: true; requested?: true } | { ok: false; reason: 'invalid-state' | 'gone' | 'invalid-id' };

export type Retryable<T> = T & { retryable: boolean };
