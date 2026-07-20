import type { Backoff, DeliveryGuarantee } from './types.js';

/** performerがキーの指定を必須と宣言するための印, ADR-0010 (ランタイムDSLではなく型で強制) */
export type Requirements = { concurrencyKey?: true; uniqueKey?: true };

/** performに渡す実行文脈,冪等化とタイムアウト追従に要る情報を揃える */
export type JobContext = {
	jobId: string;
	/** 1始まり, at-least-onceで再実行され得るため冪等化の判断材料 */
	attempt: number;
	/** ジョブ単位で安定,再実行でも同値 */
	idempotencyKey: string;
	/** timeout時にabort,performerへ協調的な中断を依頼する */
	signal: AbortSignal;
};

export abstract class Performer<Payload = unknown, Result = unknown, Req extends Requirements = {}, Env = unknown> {
	/** 型のためだけの幻影プロパティ,実体なし */
	declare protected readonly __requirements?: Req;
	/** Cloudflareのバインディング, WorkerEntrypointと同じくコンストラクタで受け取る */
	constructor(protected readonly env: Env) {}
	abstract perform(payload: Payload, ctx: JobContext): Result | Promise<Result>;
}

export type Performers = Record<string, Performer<any, any, any, any>>;

/**
 * 別Workerのperformerに渡す実行文脈
 * RPCの引数にAbortSignal非対応のため`signal`なし
 * タイムアウトは呼び出し側の待機打ち切りのみ,リモートへは非伝播
 */
export type RemoteJobContext = Omit<JobContext, 'signal'>;

/**
 * service binding越しのperformerを指す印
 * 登録簿にクラスの代わりに置くとconsumerがRPCで呼ぶ(ADR-0026)
 */
export type RemoteRef<P extends Performer<any, any, any, any> = Performer<any, any, any, any>> = {
	readonly kind: 'remote';
	/** wrangler設定のservice binding名 */
	readonly binding: string;
	/** 型のためだけの幻影プロパティ,実体なし */
	readonly __performer?: P;
};

/** performerの別Worker配置,型引数に相手の実装を渡すとpayloadの型が効く */
export function remote<P extends Performer<any, any, any, any> = Performer<any, any, any, any>>(binding: string): RemoteRef<P> {
	return { kind: 'remote', binding };
}

export function isRemoteRef(value: unknown): value is RemoteRef {
	return typeof value === 'object' && value !== null && (value as RemoteRef).kind === 'remote';
}

type PayloadOf<P> = P extends Performer<infer T, any, any, any> ? T : never;
type ReqOf<P> = P extends Performer<any, any, infer R, any> ? R : {};

/** 必須の印が1つでも立っているか */
type HasRequired<R extends Requirements> = true extends R[keyof R] ? true : false;

export type BaseOptions = {
	maxAttempts?: number;
	backoff?: Backoff;
	/** 実行開始の遅延, DO alarm管理なのでQueuesの12時間上限に縛られない */
	delayMs?: number;
	/** 絶対時刻での予約, delayMsとは排他 */
	runAt?: number;
	timeoutMs?: number;
	priority?: number;
	guarantee?: DeliveryGuarantee;
};

type KeyOptions<R extends Requirements> = (R['concurrencyKey'] extends true ? { concurrencyKey: string } : { concurrencyKey?: string }) &
	(R['uniqueKey'] extends true ? { uniqueKey: string } : { uniqueKey?: string });

export type EnqueueOptions<R extends Requirements = {}> = BaseOptions & KeyOptions<R>;

/** 必須の印があればoptionsを必須引数にする */
type EnqueueArgs<M extends Performers, K extends keyof M> =
	HasRequired<ReqOf<M[K]>> extends true
		? [binding: K, payload: PayloadOf<M[K]>, options: EnqueueOptions<ReqOf<M[K]>>]
		: [binding: K, payload: PayloadOf<M[K]>, options?: EnqueueOptions<ReqOf<M[K]>>];

export type EnqueueItem<M extends Performers, K extends keyof M = keyof M> = {
	[Key in K]: HasRequired<ReqOf<M[Key]>> extends true
		? { binding: Key; payload: PayloadOf<M[Key]>; options: EnqueueOptions<ReqOf<M[Key]>> }
		: { binding: Key; payload: PayloadOf<M[Key]>; options?: EnqueueOptions<ReqOf<M[Key]>> };
}[K];

/**
 * enqueueの型面
 * enqueueManyは実測を受けて必須化,個別RPCの逐次enqueueは78件/秒でDOの1,000 req/sソフト上限に律速される
 */
export interface JobQueue<M extends Performers> {
	enqueue(...args: { [K in keyof M]: EnqueueArgs<M, K> }[keyof M]): Promise<string>;
	enqueueMany(items: readonly EnqueueItem<M>[]): Promise<string[]>;
}
