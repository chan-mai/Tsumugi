import { WorkerEntrypoint } from 'cloudflare:workers';
import type { JobContext, PerformerLike, Requirements } from '../core/api.js';

/**
 * トップレベルexportで`ctx.exports`から解決可能(ADR-0037)
 * binding名はexport名, 別途登録不要
 * 同一Worker, 別Workerで記述共通
 */
export abstract class Performer<Payload = unknown, Result = unknown, Req extends Requirements = {}, Env = unknown>
	extends WorkerEntrypoint<Env>
	implements PerformerLike<Payload, Result, Req>
{
	declare readonly __requirements?: Req;
	abstract perform(payload: Payload, ctx: JobContext): Result | Promise<Result>;
}
