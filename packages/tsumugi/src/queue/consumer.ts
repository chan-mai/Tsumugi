import { isRemoteRef, type Performer, type RemoteJobContext, type RemoteRef } from '../core/api.js';
import { shardNameOf } from '../core/ids.js';
import type { DispatchMessage, TsumugiJobShard } from '../do/job-shard.js';

export type PerformerCtor<Env> = new (env: Env) => Performer<any, any, any, Env>;

/** service binding越しに見えるperformerの形, `RemotePerformer`の派生が満たす */
export type RemotePerformerService = {
	perform(payload: unknown, ctx: RemoteJobContext): Promise<unknown>;
};

/**
 * binding名からperformerを引く登録簿,コード側の宣言が型推論の源も兼ねる
 * `remote('SERVICE')`を置くとservice binding越しの呼び出しになる(ADR-0026)
 */
export type PerformerRegistry<Env> = Record<string, PerformerCtor<Env> | RemoteRef>;

export type ConsumerEnv = {
	JOB_SHARD: DurableObjectNamespace<TsumugiJobShard>;
};

export class TsumugiTimeoutError extends Error {
	constructor(
		readonly jobId: string,
		readonly timeoutMs: number,
	) {
		super(`ジョブがタイムアウトした(${jobId}, ${timeoutMs}ms)`);
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
 * `signal`は協調的な中断の依頼,応じないperformerは走り続ける
 */
function withTimeout<T>(jobId: string, timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	if (timeoutMs <= 0) return run(controller.signal);

	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			controller.abort();
			reject(new TsumugiTimeoutError(jobId, timeoutMs));
		}, timeoutMs);
		run(controller.signal).then(
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
	performers: PerformerRegistry<Env>,
): Promise<void> {
	await Promise.allSettled(batch.messages.map((message) => handleOne(message, env, performers)));
}

async function handleOne<Env extends ConsumerEnv>(
	message: Message<DispatchMessage>,
	env: Env,
	performers: PerformerRegistry<Env>,
): Promise<void> {
	const { jobId, binding, attempt, payload, timeoutMs, claimRequired } = message.body;
	let ok = false;
	let failure: string | undefined;

	try {
		if (claimRequired && !(await shardStub(env, jobId).claim(jobId))) {
			// 重複配送で他方が既に実行権を取っている,二重実行を避けるため何もせず降りる(ADR-0007)
			message.ack();
			return;
		}

		const entry = performers[binding];
		if (!entry) throw new Error(`performerが未登録: ${binding}`);
		const base = { jobId, attempt, idempotencyKey: jobId };

		if (isRemoteRef(entry)) {
			const service = (env as Record<string, unknown>)[entry.binding] as RemotePerformerService | undefined;
			// 設定漏れの即時失敗,握り潰すと黙って失敗し続ける
			if (typeof service?.perform !== 'function') throw new Error(`service bindingが未設定: ${entry.binding}`);
			// signalは非対応,中断の依頼はリモートに届かない(ADR-0026)
			await withTimeout(jobId, timeoutMs, () => Promise.resolve(service.perform(payload, base)));
		} else {
			await withTimeout(jobId, timeoutMs, (signal) => Promise.resolve(new entry(env).perform(payload, { ...base, signal })));
		}
		ok = true;
	} catch (error) {
		// 本文をDOへ渡す, 捨てるとダッシュボードから失敗の理由が永久に分からない(ADR-0028)
		failure = describeError(error);
		console.error(`tsumugi: perform failed (${jobId})`, error);
	}

	message.ack();

	try {
		await shardStub(env, jobId).report(jobId, failure === undefined ? { ok } : { ok, error: failure });
	} catch (error) {
		// 報告が失われるとジョブはQUEUEDのまま残る, reaperが沈黙として回収する
		console.error(`tsumugi: report failed (${jobId})`, error);
	}
}
