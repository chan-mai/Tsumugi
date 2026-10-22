import { toFailOptions, type FailOptions, type JobContext, type PerformerLike, type RemoteRef } from '../core/api.js';
import { assertNodeId } from '../core/flow.js';
import { shardNameOf } from '../core/ids.js';
import { LOG_MAX_CHARS, LOG_MIN_INTERVAL_MS } from '../core/log.js';
import type { SpawnRequest } from '../core/run.js';
import type { DispatchMessage, TsumugiJobShard } from '../do/job-shard.js';

export type PerformerCtor<Env> = new (ctx: ExecutionContext, env: Env) => PerformerLike<any, any, any>;

export type PerformerService = {
	perform(payload: unknown, ctx: JobContext): Promise<unknown>;
};

export type PerformerSource = Record<string, PerformerService | undefined>;

/** binding名とperformerの対応, binding名一覧とpayload型の導出専用で実行時解決には不使用(ADR-0037) */
export type PerformerRegistry<Env> = Record<string, PerformerCtor<Env> | RemoteRef>;

export type ConsumerEnv = {
	JOB_SHARD: DurableObjectNamespace<TsumugiJobShard>;
};

export const HEARTBEAT_MIN_INTERVAL_MS = 5_000;

export const HEARTBEAT_SEND_TIMEOUT_MS = 1_000;

/** 送信失敗は破棄, 報告欠落時もreaperの検出のみで実行は継続 */
export function createHeartbeat(
	send: (progress?: number) => Promise<{ accepted: boolean; cancelRequested: boolean }>,
	now: () => number,
	minIntervalMs = HEARTBEAT_MIN_INTERVAL_MS,
	sendTimeoutMs = HEARTBEAT_SEND_TIMEOUT_MS,
): (progress?: number) => Promise<{ cancelRequested: boolean }> {
	let lastAt = Number.NEGATIVE_INFINITY;
	let cancelRequested = false;
	return async (progress) => {
		const at = now();
		if (at - lastAt < minIntervalMs) return { cancelRequested };
		lastAt = at;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			// sendの同期例外も捕捉, performへの伝播なし
			const sending = Promise.resolve()
				.then(() => send(progress))
				.then(
					(ack) => {
						if (ack.cancelRequested || !ack.accepted) cancelRequested = true;
					},
					(error: unknown) => {
						console.error('tsumugi: heartbeat failed', error);
					},
				);
			await Promise.race([
				sending,
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, sendTimeoutMs);
				}),
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
		return { cancelRequested };
	};
}

export function createLog(
	send: (message: string) => Promise<unknown>,
	now: () => number,
	minIntervalMs = LOG_MIN_INTERVAL_MS,
	sendTimeoutMs = 1_000,
): (message: string) => Promise<void> {
	let lastAt = Number.NEGATIVE_INFINITY;
	return async (message) => {
		if (typeof message !== 'string') return;
		const at = now();
		if (at - lastAt < minIntervalMs) return;
		lastAt = at;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const sending = Promise.resolve()
				.then(() => send(message.slice(0, LOG_MAX_CHARS)))
				.catch((error: unknown) => {
					console.error('tsumugi: log failed', error);
				});
			await Promise.race([
				sending,
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, sendTimeoutMs);
				}),
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	};
}

export class TsumugiTimeoutError extends Error {
	constructor(
		readonly jobId: string,
		readonly timeoutMs: number,
	) {
		super(`job timed out (${jobId}, ${timeoutMs}ms)`);
		this.name = 'TsumugiTimeoutError';
	}
}

export function shardStub<Env extends ConsumerEnv>(env: Env, jobId: string): DurableObjectStub<TsumugiJobShard> {
	return env.JOB_SHARD.get(env.JOB_SHARD.idFromName(shardNameOf(jobId)));
}

// timeoutでの待機終了, performer実行自体は停止不可(ADR-0037)
// 中断が必要なperformerは`ctx.deadlineAt`から自前でAbortSignal作成
// `touch`は期限再計測, 生存報告受理ごとに呼びDO側reaper期限と起点を同期
function withTimeout<T>(jobId: string, timeoutMs: number, run: (touch: () => void) => Promise<T>): Promise<T> {
	if (timeoutMs <= 0) return run(() => {});

	return new Promise<T>((resolve, reject) => {
		let fired = false;
		const fire = () => {
			fired = true;
			reject(new TsumugiTimeoutError(jobId, timeoutMs));
		};
		let timer = setTimeout(fire, timeoutMs);
		const touch = () => {
			// 中断後の再計測は無視, 遅延した受理による期限復活防止
			if (fired) return;
			clearTimeout(timer);
			timer = setTimeout(fire, timeoutMs);
		};
		run(touch).then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/** 切り詰めはDO側, `stack`は1行目に`Name: message`を含む */
export function describeError(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	return error.stack ?? `${error.name}: ${error.message}`;
}

/**
 * 成否によらず必ずack(ADR-0004)
 * Queuesのretry不使用で`max_retries`/`delaySeconds`の上限回避, リトライとバックオフはDOのalarmで管理
 */
export async function handleBatch<Env extends ConsumerEnv>(
	batch: MessageBatch<DispatchMessage>,
	env: Env,
	exports: PerformerSource = {},
): Promise<void> {
	const results = await Promise.allSettled(batch.messages.map((message) => handleOne(message, env, exports)));
	// 漏れた例外は再送出せずログのみ, 再送出は未ackでQueuesリトライ発生(ADR-0004)
	for (const result of results) {
		if (result.status === 'rejected') console.error('tsumugi: handleOne rejected', result.reason);
	}
}

async function handleOne<Env extends ConsumerEnv>(message: Message<DispatchMessage>, env: Env, exports: PerformerSource): Promise<void> {
	// 報告先特定用jobIdをtry外で保持, 本文不正時は未取得
	let jobId: string | undefined;
	let ok = false;
	let failure: string | undefined;
	let result: unknown;
	const spawns: SpawnRequest[] = [];
	let fail: FailOptions | undefined;

	try {
		// 分割代入もtry内, 本文null等の例外でのack欠落防止(ADR-0004)
		const body = message.body;
		if (typeof body?.jobId !== 'string') throw new Error('invalid dispatch message: jobId is missing');
		jobId = body.jobId;
		const { binding, attempt, payload, timeoutMs, claimRequired, expiresAt, traceparent } = body;

		// 期限切れは非実行, 滞留解消時の一括実行防止(ADR-0047)
		// 報告失敗時はreaperが期限切れとしてCANCELLEDへ遷移
		if (typeof expiresAt === 'number' && Date.now() >= expiresAt) {
			await shardStub(env, jobId)
				.expire(jobId)
				.catch((error: unknown) => {
					console.error(`tsumugi: expire failed (${jobId})`, error);
				});
			message.ack();
			return;
		}

		if (claimRequired && !(await shardStub(env, jobId).claim(jobId))) {
			// 重複配送で他方が実行権取得済み, 二重実行回避で終了(ADR-0007)
			message.ack();
			return;
		}

		// 同一Workerは`ctx.exports`, 別Workerはservice bindingの`env`から解決(ADR-0037)
		const service = (exports[binding] ?? (env as Record<string, unknown>)[binding]) as PerformerService | undefined;
		// 設定漏れは即時失敗, 無視すると未検知のまま失敗継続
		if (typeof service?.perform !== 'function') {
			throw new Error(`performer not found: ${binding} (export it, or add a service binding)`);
		}

		// 要求は保持のみ, 送信は完了報告と同時(ADR-0031)
		// 関数はRPC stubとして別Workerのperformerからも呼び出し可能(ADR-0037)
		const spawn = (id: string, target: string, childPayload: unknown, options?: SpawnRequest['options']) => {
			// ID形式検証, 不正値はRun DOで受理不可で通知滞留
			assertNodeId(id);
			spawns.push({ id, binding: target, payload: childPayload, ...(options ? { options } : {}) });
		};
		const stableId = jobId;
		const stub = shardStub(env, stableId);

		result = await withTimeout(stableId, timeoutMs, (touch) => {
			// DO受理の報告のみ期限再計測, timeoutMsを報告間隔として利用
			const heartbeat = createHeartbeat(
				(progress) =>
					stub.heartbeat(stableId, progress).then((ack) => {
						if (ack.accepted) touch();
						return ack;
					}),
				() => Date.now(),
			);
			const log = createLog(
				(message) => stub.log(stableId, attempt, message),
				() => Date.now(),
			);
			const ctx: JobContext = {
				jobId: stableId,
				attempt,
				idempotencyKey: stableId,
				traceparent: traceparent ?? null,
				deadlineAt: Date.now() + timeoutMs,
				spawn,
				heartbeat,
				log,
				fail: (options) => {
					fail = toFailOptions(options);
				},
			};
			return Promise.resolve(service.perform(payload, ctx));
		});
		ok = true;
	} catch (error) {
		// エラー本文をDOへ送信, 失敗理由のダッシュボード表示用(ADR-0028)
		failure = describeError(error);
		console.error(`tsumugi: perform failed (${jobId ?? 'unknown'})`, error);
	}

	message.ack();

	// jobId無しは本文不正, 報告先が無くackのみ
	// DO側ジョブはQUEUEDのまま, timeout経過後にreaperが無応答として処理
	if (jobId === undefined) return;

	try {
		// exactOptionalPropertyTypes対応でerror未定義は省略
		// 失敗試行のspawnは非送信, 再実行時に再要求(ADR-0032)
		const outcome = ok
			? { ok: true, result, ...(spawns.length > 0 ? { spawns } : {}) }
			: { ok: false, ...(failure === undefined ? {} : { error: failure }), ...(fail ? { fail } : {}) };
		await shardStub(env, jobId).report(jobId, outcome);
	} catch (error) {
		// 報告喪失時はQUEUEDのまま, reaperが無応答として処理
		console.error(`tsumugi: report failed (${jobId})`, error);
	}
}
