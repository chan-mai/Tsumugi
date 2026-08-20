import { WorkerEntrypoint } from 'cloudflare:workers';
import type { JobContext, PerformerLike, Requirements } from '../core/api.js';

/**
 * performerの基底(ADR-0037)
 *
 * `WorkerEntrypoint`の派生で、トップレベルのexportにより`ctx.exports`から解決可能
 * binding名はexportした名前をそのまま使用, 別途の登録は不要
 * 同一Workerに置くか別Workerに置くかで書き方は変わらない
 */
export abstract class Performer<Payload = unknown, Result = unknown, Req extends Requirements = {}, Env = unknown>
	extends WorkerEntrypoint<Env>
	implements PerformerLike<Payload, Result, Req>
{
	/** 型のためだけのプロパティ, 実体なし */
	declare readonly __requirements?: Req;
	abstract perform(payload: Payload, ctx: JobContext): Result | Promise<Result>;
}
