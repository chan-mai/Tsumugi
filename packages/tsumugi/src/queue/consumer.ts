import type { JobContext, PerformerLike, RemoteRef } from '../core/api.js';
import { shardNameOf } from '../core/ids.js';
import type { SpawnRequest } from '../core/run.js';
import type { DispatchMessage, TsumugiJobShard } from '../do/job-shard.js';

export type PerformerCtor<Env> = new (ctx: ExecutionContext, env: Env) => PerformerLike<any, any, any>;

/** 解決したperformerの形, 同一Workerでも別Workerでも同じ(ADR-0037) */
export type PerformerService = {
	perform(payload: unknown, ctx: JobContext): Promise<unknown>;
};

/**
 * performerを引く先(ADR-0037)
 * 同一Workerは`ctx.exports`, 別Workerはservice bindingの`env`
 */
export type PerformerSource = Record<string, PerformerService | undefined>;

/**
 * binding名からperformerを引く対応
 * 実行時の解決には使わない, binding名の一覧とpayloadの型の導出だけに使う(ADR-0037)
 */
export type PerformerRegistry<Env> = Record<string, PerformerCtor<Env> | RemoteRef>;

export type ConsumerEnv = {
	JOB_SHARD: DurableObjectNamespace<TsumugiJobShard>;
};

/**
 * 生存報告をDOへ送る最短の間隔
 * performerが短い周期で実行してもDOへの書き込みはこの間隔に収まる
 */
export const HEARTBEAT_MIN_INTERVAL_MS = 5_000;

/** 生存報告の送信を待つ上限, DOが応答しなくてもperformerの処理を止めない */
export const HEARTBEAT_SEND_TIMEOUT_MS = 1_000;

/**
 * 間引き付きの生存報告を作る
 * 直前の送信からの経過が下限に満たない要求は送信せずに捨てる
 * 送信の失敗は捨てる, 報告が届かなくてもreaperが回収するだけで実行自体は続く
 * 送信の待機には上限があり, 超えた分は結果を待たずに捨てる
 */
export function createHeartbeat(
	send: (progress?: number) => Promise<unknown>,
	now: () => number,
	minIntervalMs = HEARTBEAT_MIN_INTERVAL_MS,
	sendTimeoutMs = HEARTBEAT_SEND_TIMEOUT_MS,
): (progress?: number) => Promise<void> {
	let lastAt = Number.NEGATIVE_INFINITY;
	return async (progress) => {
		const at = now();
		if (at - lastAt < minIntervalMs) return;
		lastAt = at;
		const sending = Promise.resolve(send(progress)).then(
			() => undefined,
			(error: unknown) => {
				console.error('tsumugi: heartbeat failed', error);
			},
		);
		await Promise.race([sending, new Promise<void>((resolve) => setTimeout(resolve, sendTimeoutMs))]);
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

/**
 * timeoutで待つのをやめる
 *
 * performerの実行自体は止められない,ランタイムの制約で回避不能
 * 中断が要るperformerは`ctx.deadlineAt`から自分でAbortSignalを作る(ADR-0037)
 * `touch`は期限の測り直し, 生存報告が受理されるたびに呼びDO側のreaper期限と起点を揃える
 */
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
			// 打ち切り後の測り直しは受けない, 遅れて届いた受理で期限が復活しないようにする
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

/**
 * 例外を文字列にする, 打ち切りはDO側が持つのでここでは形だけ整える
 * `stack`は1行目に`Name: message`を含むので繋げると重複する
 */
export function describeError(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	return error.stack ?? `${error.name}: ${error.message}`;
}

/**
 * Queuesのconsumer
 *
 * 成否によらず必ずackする(ADR-0004)
 * Queuesのretryに乗せないことで`max_retries`と`delaySeconds`の上限が製品仕様に漏れなくなり,
 * リトライ回数もバックオフも全てDOのalarmが持てるようになる
 */
export async function handleBatch<Env extends ConsumerEnv>(
	batch: MessageBatch<DispatchMessage>,
	env: Env,
	exports: PerformerSource = {},
): Promise<void> {
	const results = await Promise.allSettled(batch.messages.map((message) => handleOne(message, env, exports)));
	// handleOneは内部で捕捉しきる想定だが, 漏れた例外を再送出するとackされずQueuesのリトライに乗る(ADR-0004)
	for (const result of results) {
		if (result.status === 'rejected') console.error('tsumugi: handleOne rejected', result.reason);
	}
}

async function handleOne<Env extends ConsumerEnv>(message: Message<DispatchMessage>, env: Env, exports: PerformerSource): Promise<void> {
	// 報告先の特定にjobIdが必要なのでtryの外で保持する, 本文が壊れていれば取れないままになる
	let jobId: string | undefined;
	let ok = false;
	let failure: string | undefined;
	let result: unknown;
	// performの中で要求された子, 完了報告に同梱して運ぶ(ADR-0031)
	const spawns: SpawnRequest[] = [];

	try {
		// 分割代入もtryに入れる, 本文がnull等で壊れていても例外がackを飛ばさない(ADR-0004)
		const body = message.body;
		// jobIdが無い/文字列でない本文はここで弾く, performer実行とreportの対象にしない
		if (typeof body?.jobId !== 'string') throw new Error('invalid dispatch message: jobId is missing');
		jobId = body.jobId;
		const { binding, attempt, payload, timeoutMs, claimRequired } = body;

		if (claimRequired && !(await shardStub(env, jobId).claim(jobId))) {
			// 重複配送で他方が既に実行権を取っている,二重実行を避けるため何もせず降りる(ADR-0007)
			message.ack();
			return;
		}

		// 同一Workerのperformerは`ctx.exports`から, 別Workerはservice bindingの`env`から引く(ADR-0037)
		const service = (exports[binding] ?? (env as Record<string, unknown>)[binding]) as PerformerService | undefined;
		// 設定漏れは即時失敗にする, 捕捉して無視すると検知できないまま失敗が続く
		if (typeof service?.perform !== 'function') {
			throw new Error(`performer not found: ${binding} (export it, or add a service binding)`);
		}

		// 要求は溜めるだけ, 送るのは完了報告と同じ便(ADR-0031)
		// 関数はRPCのstubとして越えるので, 別Workerのperformerからも呼べる(ADR-0037)
		const spawn = (id: string, target: string, childPayload: unknown, options?: SpawnRequest['options']) => {
			spawns.push({ id, binding: target, payload: childPayload, ...(options ? { options } : {}) });
		};
		const stableId = jobId;
		const stub = shardStub(env, stableId);

		// performの戻り値を拾ってDOへ渡す, 保存はDO側で行う(#9)
		result = await withTimeout(stableId, timeoutMs, (touch) => {
			// DOが受理した報告だけ期限を測り直す, timeoutMsを報告間隔として扱えるようにする
			const heartbeat = createHeartbeat(
				(progress) =>
					stub.heartbeat(stableId, progress).then((accepted) => {
						if (accepted) touch();
					}),
				() => Date.now(),
			);
			const ctx = { jobId: stableId, attempt, idempotencyKey: stableId, deadlineAt: Date.now() + timeoutMs, spawn, heartbeat };
			return Promise.resolve(service.perform(payload, ctx));
		});
		ok = true;
	} catch (error) {
		// 本文をDOへ渡す, 捨てるとダッシュボードから失敗の理由が永久に分からない(ADR-0028)
		failure = describeError(error);
		console.error(`tsumugi: perform failed (${jobId ?? 'unknown'})`, error);
	}

	message.ack();

	// jobIdが取れないのは本文が壊れている場合, 報告先が無いのでackだけで終える
	// DO側のジョブはQUEUEDのまま残り, timeout経過後にreaperが無応答として回収する
	if (jobId === undefined) return;

	try {
		// exactOptionalPropertyTypesのためerror未定義は省いて渡す
		// 失敗した試行のspawnは載せない, 再実行でもう一度要求される(ADR-0032)
		const outcome = ok
			? { ok: true, result, ...(spawns.length > 0 ? { spawns } : {}) }
			: failure === undefined
				? { ok: false }
				: { ok: false, error: failure };
		await shardStub(env, jobId).report(jobId, outcome);
	} catch (error) {
		// 報告が失われるとジョブはQUEUEDのまま残る, reaperが無応答として回収する
		console.error(`tsumugi: report failed (${jobId})`, error);
	}
}
