import type { JobContext, PerformerLike, RemoteRef } from '../core/api.js';
import { assertNodeId } from '../core/flow.js';
import { shardNameOf } from '../core/ids.js';
import type { SpawnRequest } from '../core/run.js';
import type { DispatchMessage, TsumugiJobShard } from '../do/job-shard.js';

export type PerformerCtor<Env> = new (ctx: ExecutionContext, env: Env) => PerformerLike<any, any, any>;

/** 解決したperformerの形, 同一Workerでも別Workerでも同じ(ADR-0037) */
export type PerformerService = {
	perform(payload: unknown, ctx: JobContext): Promise<unknown>;
};

/**
 * performerの解決先(ADR-0037)
 * 同一Workerは`ctx.exports`, 別Workerはservice bindingの`env`
 */
export type PerformerSource = Record<string, PerformerService | undefined>;

/**
 * binding名からperformerを解決する対応
 * 実行時の解決には不使用, binding名の一覧とpayloadの型の導出だけに使用(ADR-0037)
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

/** 生存報告の送信を待つ上限, DOが応答しなくてもperformerの処理は継続 */
export const HEARTBEAT_SEND_TIMEOUT_MS = 1_000;

/**
 * 間隔制限付きの生存報告の作成
 * 直前の送信からの経過が下限に満たない要求は送信せず破棄
 * 送信の失敗は破棄, 報告が届かなくてもreaperが回収するだけで実行自体は継続
 * 送信の待機には上限があり、超えた分は結果を待たず破棄
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
 * timeoutでの待機の終了
 *
 * performerの実行自体は止められず、ランタイムの制約で回避不能
 * 中断が必要なperformerは`ctx.deadlineAt`から自分でAbortSignalを作成(ADR-0037)
 * `touch`は期限の再計測, 生存報告が受理されるたびに呼びDO側のreaper期限と起点を同期
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
			// 中断後の再計測は受け付けない, 遅れて届いた受理での期限の復活を防止
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
 * 例外を文字列へ変換, 中断はDO側が持ちここでは形式の調整のみ
 * `stack`は1行目に`Name: message`を含み連結では重複
 */
export function describeError(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	return error.stack ?? `${error.name}: ${error.message}`;
}

/**
 * Queuesのconsumer
 *
 * 成否によらず必ずackする(ADR-0004)
 * Queuesのretryを使わず`max_retries`と`delaySeconds`の上限を製品仕様から排除
 * リトライ回数もバックオフも全てDOのalarmが保持
 */
export async function handleBatch<Env extends ConsumerEnv>(
	batch: MessageBatch<DispatchMessage>,
	env: Env,
	exports: PerformerSource = {},
): Promise<void> {
	const results = await Promise.allSettled(batch.messages.map((message) => handleOne(message, env, exports)));
	// handleOneは内部で捕捉しきる想定だが、漏れた例外を再送出するとackされずQueuesのリトライが発生(ADR-0004)
	for (const result of results) {
		if (result.status === 'rejected') console.error('tsumugi: handleOne rejected', result.reason);
	}
}

async function handleOne<Env extends ConsumerEnv>(message: Message<DispatchMessage>, env: Env, exports: PerformerSource): Promise<void> {
	// 報告先の特定に必要なjobIdをtryの外で保持, 本文が壊れていれば未取得のまま
	let jobId: string | undefined;
	let ok = false;
	let failure: string | undefined;
	let result: unknown;
	// performの中で要求された子, 完了報告に同梱して送信(ADR-0031)
	const spawns: SpawnRequest[] = [];

	try {
		// 分割代入もtryの中, 本文がnull等で壊れていても例外によるackの欠落を防止(ADR-0004)
		const body = message.body;
		// jobIdが無い/文字列でない本文はここで拒否, performer実行とreportの対象外
		if (typeof body?.jobId !== 'string') throw new Error('invalid dispatch message: jobId is missing');
		jobId = body.jobId;
		const { binding, attempt, payload, timeoutMs, claimRequired, expiresAt } = body;

		// 期限切れは実行せず終了(ADR-0047), 滞留から復帰した時のまとめ実行を防止
		// 報告の失敗はreaperがSCHEDULEDへ回収し次のtickの判定で期限切れ
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
			// 重複配送で他方が既に実行権を取得済み, 二重実行の回避で何もせず終了(ADR-0007)
			message.ack();
			return;
		}

		// 同一Workerのperformerは`ctx.exports`から, 別Workerはservice bindingの`env`から解決(ADR-0037)
		const service = (exports[binding] ?? (env as Record<string, unknown>)[binding]) as PerformerService | undefined;
		// 設定漏れは即時失敗, 捕捉して無視すると検知できないまま失敗が継続
		if (typeof service?.perform !== 'function') {
			throw new Error(`performer not found: ${binding} (export it, or add a service binding)`);
		}

		// 要求は保持のみ, 送信は完了報告と同時(ADR-0031)
		// 関数はRPCのstubとして越え、別Workerのperformerからも呼び出し可能(ADR-0037)
		const spawn = (id: string, target: string, childPayload: unknown, options?: SpawnRequest['options']) => {
			// IDの形式検証, 不正な値はRun DOで受理できず通知が滞留
			assertNodeId(id);
			spawns.push({ id, binding: target, payload: childPayload, ...(options ? { options } : {}) });
		};
		const stableId = jobId;
		const stub = shardStub(env, stableId);

		// performの戻り値をDOへ渡す, 保存はDO側が担当(#9)
		result = await withTimeout(stableId, timeoutMs, (touch) => {
			// DOが受理した報告だけ期限を再計測, timeoutMsが報告間隔として機能
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
		// 本文をDOへ渡す, 破棄するとダッシュボードから失敗の理由が永久に不明(ADR-0028)
		failure = describeError(error);
		console.error(`tsumugi: perform failed (${jobId ?? 'unknown'})`, error);
	}

	message.ack();

	// jobIdが取れないのは本文が壊れている場合, 報告先が無いのでackだけで終える
	// DO側のジョブはQUEUEDのまま残り、timeout経過後にreaperが無応答として回収
	if (jobId === undefined) return;

	try {
		// exactOptionalPropertyTypesのためerror未定義は省いて渡す
		// 失敗した試行のspawnは非送信, 再実行で再度要求が届く(ADR-0032)
		const outcome = ok
			? { ok: true, result, ...(spawns.length > 0 ? { spawns } : {}) }
			: failure === undefined
				? { ok: false }
				: { ok: false, error: failure };
		await shardStub(env, jobId).report(jobId, outcome);
	} catch (error) {
		// 報告が失われるとジョブはQUEUEDのまま残る, reaperが無応答として回収
		console.error(`tsumugi: report failed (${jobId})`, error);
	}
}
