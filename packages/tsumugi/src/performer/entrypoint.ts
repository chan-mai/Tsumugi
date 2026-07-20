import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Requirements, RemoteJobContext } from '../core/api.js';

/**
 * 別Workerに置くperformerの基底
 *
 * `Performer`と違い`WorkerEntrypoint`の派生,呼び出し側にはservice bindingのRPCとして見える
 * 戻り値と`throw`の扱いはローカルと同一,例外がそのままリトライの判断
 */
export abstract class RemotePerformer<
	Payload = unknown,
	Result = unknown,
	Req extends Requirements = {},
	Env = unknown,
> extends WorkerEntrypoint<Env> {
	/** 型のためだけの幻影プロパティ,実体なし */
	declare protected readonly __requirements?: Req;
	abstract perform(payload: Payload, ctx: RemoteJobContext): Result | Promise<Result>;
}
