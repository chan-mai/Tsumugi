import type { SpawnRequest } from './run.js';
import type { Backoff, DeliveryGuarantee, FailureNotice, SettledNotice } from './types.js';

/** performerのキー指定必須の宣言, 型で強制(ADR-0010) */
export type Requirements = { concurrencyKey?: true; uniqueKey?: true };

export type JobContext = {
	jobId: string;
	/** 1始まり, at-least-once再実行時の冪等化判断用 */
	attempt: number;
	/** ジョブ単位, 再実行でも同値 */
	idempotencyKey: string;
	traceparent: string | null;
	/** 試行番号付き実行ログ, 本文2,000文字, 最新20件まで保存, 最短間隔1秒 */
	log(message: string): Promise<void>;
	/**
	 * timeout到達時刻(epochミリ秒)
	 * `AbortSignal`はRPC経由不可, 中断用signalは残り時間から作成
	 */
	deadlineAt: number;
	/**
	 * 無応答判定とtimeoutの起点は最後の報告時刻, timeoutMsを最長所要時間に合わせる必要なし
	 * `progress`は0以上1以下, 範囲外は両端へ丸め, 非数は進捗なし扱い
	 * 実行間隔の下限未満の呼び出しは送信なし, 戻り値は前回結果
	 * `cancelRequested`は取り消し要求の有無(#95), 一度trueなら以後もtrue
	 * 回収済み, 終端など報告が記録されない状態もtrue, 継続不要を示す
	 * 中断時はthrow, 正常returnはCOMPLETED扱い
	 */
	heartbeat(progress?: number): Promise<{ cancelRequested: boolean }>;
	/**
	 * 実行中のノードの下に子ノードを追加(ADR-0032)
	 * 要求はperformの完了報告に同梱, 失敗した試行の要求は破棄
	 * 静的定義と異なり型検査なし
	 * 別Workerのperformerでは`await`必須, 無いとperform終了までにRPC呼び出しが未完了(ADR-0037)
	 */
	spawn(id: string, binding: string, payload: unknown, options?: SpawnRequest['options']): void | Promise<void>;
	/**
	 * この試行の失敗時の再試行指定(#91)
	 * `retry: false`は試行回数の残りに関わらずFAILED, `retryAt`はbackoffに代わる次回実行時刻
	 * throwで終えた試行のみ適用, 正常returnはCOMPLETED扱い
	 * 複数回呼び出し時は最後の指定を採用
	 * 別Workerのperformerでは`await`必須, 無いとperform終了までにRPC呼び出しが未完了(ADR-0037)
	 */
	fail(options: FailOptions): void | Promise<void>;
};

/**
 * 失敗した試行の扱い(#91)
 * `retryAt`はepochミリ秒, 試行回数上限と期限は通常の再試行と同様に適用
 */
export type FailOptions = { retry: false } | { retryAt: number };

/** 形式検証と複製, RPC経由値の参照不保持 */
export function toFailOptions(options: unknown): FailOptions {
	const value = options as Partial<{ retry: unknown; retryAt: unknown }> | null | undefined;
	if (value?.retry === false) return { retry: false };
	if (typeof value?.retryAt === 'number' && Number.isFinite(value.retryAt)) return { retryAt: value.retryAt };
	throw new TypeError('invalid fail options: expected { retry: false } or { retryAt: <epoch ms> }');
}

/** 実体は`performer/entrypoint.ts`, coreはworkerd API非依存(ADR-0018) */
export type PerformerLike<Payload = unknown, Result = unknown, Req extends Requirements = {}> = {
	perform(payload: Payload, ctx: JobContext): Result | Promise<Result>;
	/** 型専用, 実体なし */
	readonly __requirements?: Req;
};

export type Performers = Record<string, PerformerLike<any, any, any>>;

/**
 * 実行時はservice bindingで解決, ここは型の伝達のみ(ADR-0037)
 * binding名は`performers`のキー
 */
export type RemoteRef<P extends PerformerLike<any, any, any> = PerformerLike<any, any, any>> = {
	readonly kind: 'remote';
	/** 型専用, 実体なし */
	readonly __performer?: P;
};

/** performerの別Worker配置, 型引数に実装の型を指定するとpayloadを型検査 */
export function remote<P extends PerformerLike<any, any, any> = PerformerLike<any, any, any>>(): RemoteRef<P> {
	return { kind: 'remote' };
}

export function isRemoteRef(value: unknown): value is RemoteRef {
	return typeof value === 'object' && value !== null && (value as RemoteRef).kind === 'remote';
}

export type PayloadOf<P> = P extends PerformerLike<infer T, any, any> ? T : never;

/**
 * 失敗通知先に指定可能なbinding(#30)
 * `FailureNotice`をpayloadに取るperformerのみ, 他は通知が必ず失敗
 */
export type FailurePerformer<M extends Performers> = {
	[K in keyof M]: FailureNotice extends PayloadOf<M[K]> ? K : never;
}[keyof M] &
	string;

/**
 * 終端通知先に指定可能なbinding(#96)
 * `SettledNotice`をpayloadに取るperformerのみ, 他は通知が必ず失敗
 */
export type SettledPerformer<M extends Performers> = {
	[K in keyof M]: SettledNotice extends PayloadOf<M[K]> ? K : never;
}[keyof M] &
	string;
export type ReqOf<P> = P extends PerformerLike<any, any, infer R> ? R : {};
export type ResultOf<P> = P extends PerformerLike<any, infer R, any> ? Awaited<R> : never;

type HasRequired<R extends Requirements> = true extends R[keyof R] ? true : false;

export type BaseOptions = {
	traceparent?: string;
	maxAttempts?: number;
	backoff?: Backoff;
	/** 実行開始の遅延, Queuesの12時間上限なし */
	delayMs?: number;
	/** 実行開始の絶対時刻, delayMsと排他 */
	runAt?: number;
	/** 実行開始期限の絶対時刻, 経過後は実行せずCANCELLED */
	expiresAt?: number;
	/** 投入時刻からの相対期限, expiresAtと排他 */
	expiresInMs?: number;
	timeoutMs?: number;
	priority?: number;
	guarantee?: DeliveryGuarantee;
};

type KeyOptions<R extends Requirements> = (R['concurrencyKey'] extends true ? { concurrencyKey: string } : { concurrencyKey?: string }) &
	(R['uniqueKey'] extends true ? { uniqueKey: string } : { uniqueKey?: string });

export type EnqueueOptions<R extends Requirements = {}> = BaseOptions & KeyOptions<R>;

type EnqueueArgs<M extends Performers, K extends keyof M> =
	HasRequired<ReqOf<M[K]>> extends true
		? [binding: K, payload: PayloadOf<M[K]>, options: EnqueueOptions<ReqOf<M[K]>>]
		: [binding: K, payload: PayloadOf<M[K]>, options?: EnqueueOptions<ReqOf<M[K]>>];

export type EnqueueItem<M extends Performers, K extends keyof M = keyof M> = {
	[Key in K]: HasRequired<ReqOf<M[Key]>> extends true
		? { binding: Key; payload: PayloadOf<M[Key]>; options: EnqueueOptions<ReqOf<M[Key]>> }
		: { binding: Key; payload: PayloadOf<M[Key]>; options?: EnqueueOptions<ReqOf<M[Key]>> };
}[K];

/** 逐次enqueueは78件/秒(DOの1,000 req/sソフト上限律速), 大量投入はenqueueMany */
export interface JobQueue<M extends Performers> {
	enqueue(...args: { [K in keyof M]: EnqueueArgs<M, K> }[keyof M]): Promise<string>;
	enqueueMany(items: readonly EnqueueItem<M>[]): Promise<string[]>;
}

export type PerformersOf<R extends Record<string, unknown>> = {
	[K in keyof R]: R[K] extends RemoteRef<infer P>
		? P
		: R[K] extends new (ctx: any, env: any) => infer I
			? I extends PerformerLike<any, any, any>
				? I
				: never
			: never;
};

// 分配した関数引数の反変性を利用
type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;

/**
 * 全performerは同一Worker環境で初期化(#5)
 * unionでは一部performerのbindingのみ満たす環境も検査を通過
 */
export type EnvOf<R extends Record<string, unknown>> = UnionToIntersection<
	{ [K in keyof R]: R[K] extends new (ctx: any, env: infer E) => any ? E : never }[keyof R]
>;

type ExtraInputFields = {
	/** uniqueKey予約の保持期間, 経過後は同じキーでも新規ジョブ */
	uniqueForMs?: number;
	/** shard分割時の投入先決定用(ADR-0011) */
	partitionKey?: string;
};

/** 構造は`EnqueueInput`の部分集合, 実行時はそのままDOへ転送可能 */
export type TypedEnqueueInput<M extends Performers, K extends keyof M = keyof M> = {
	[Key in K]: { binding: Key; payload: PayloadOf<M[Key]> } & EnqueueOptions<ReqOf<M[Key]>> & ExtraInputFields;
}[K];
