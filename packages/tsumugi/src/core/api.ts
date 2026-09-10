import type { SpawnRequest } from './run.js';
import type { Backoff, DeliveryGuarantee, FailureNotice } from './types.js';

/** performerがキーの指定を必須と宣言するための印, ADR-0010 (ランタイムDSLではなく型で強制) */
export type Requirements = { concurrencyKey?: true; uniqueKey?: true };

/** performに渡す実行文脈, 冪等化とタイムアウト追従に必要な情報一式 */
export type JobContext = {
	jobId: string;
	/** 1始まり, at-least-onceで再実行され得るため冪等化の判断材料 */
	attempt: number;
	/** ジョブ単位で安定,再実行でも同値 */
	idempotencyKey: string;
	/**
	 * timeoutが切れる時刻, epochミリ秒
	 * `AbortSignal`はRPCを越えられず時刻を渡す, 中断が必要なperformerは残り時間から作成
	 */
	deadlineAt: number;
	/**
	 * 実行中であることをDOへ報告
	 * 報告のあいだは無応答判定とtimeoutの起点が最後の報告時刻に移り、timeoutMsの最長所要時間への調整が不要
	 * `progress`は0以上1以下, 範囲外は両端へ丸め、非数は進捗なしの扱い
	 * 実行間隔には下限があり、下限に満たない要求は送信せず破棄
	 */
	heartbeat(progress?: number): Promise<void>;
	/**
	 * 実行中のノードの下に子ノードを追加(ADR-0032)
	 * 要求はperformの完了報告に同梱, 失敗した試行の要求は破棄
	 * 静的定義と異なり型検査は非適用
	 *
	 * 別Workerのperformerでは`await`が必要, RPC呼び出しはperformの終了に間に合わない(ADR-0037)
	 */
	spawn(id: string, binding: string, payload: unknown, options?: SpawnRequest['options']): void | Promise<void>;
};

/**
 * 型の導出に使うperformerの面
 * 実体は`performer/entrypoint.ts`が持つ, coreはworkerd APIへ依存不可(ADR-0018)
 */
export type PerformerLike<Payload = unknown, Result = unknown, Req extends Requirements = {}> = {
	perform(payload: Payload, ctx: JobContext): Result | Promise<Result>;
	/** 型のためだけのプロパティ, 実体なし */
	readonly __requirements?: Req;
};

export type Performers = Record<string, PerformerLike<any, any, any>>;

/**
 * 別Workerに置くperformerを指す印(ADR-0026)
 * 実行時の解決はservice binding, ここは型の伝達のみ(ADR-0037)
 * binding名は`performers`のキーをそのまま使用
 */
export type RemoteRef<P extends PerformerLike<any, any, any> = PerformerLike<any, any, any>> = {
	readonly kind: 'remote';
	/** 型のためだけのプロパティ, 実体なし */
	readonly __performer?: P;
};

/** performerの別Worker配置, 型引数に相手の実装を渡すとpayloadの型検査が有効 */
export function remote<P extends PerformerLike<any, any, any> = PerformerLike<any, any, any>>(): RemoteRef<P> {
	return { kind: 'remote' };
}

export function isRemoteRef(value: unknown): value is RemoteRef {
	return typeof value === 'object' && value !== null && (value as RemoteRef).kind === 'remote';
}

export type PayloadOf<P> = P extends PerformerLike<infer T, any, any> ? T : never;

/**
 * 失敗の通知先に使えるbinding(#30)
 * `FailureNotice`を受け取れるperformerのみ許可, 取り違えると通知が必ず失敗
 */
export type FailurePerformer<M extends Performers> = {
	[K in keyof M]: FailureNotice extends PayloadOf<M[K]> ? K : never;
}[keyof M] &
	string;
export type ReqOf<P> = P extends PerformerLike<any, any, infer R> ? R : {};
/** performの戻り値, DAGのノードでは後段のpayloadの材料 */
export type ResultOf<P> = P extends PerformerLike<any, infer R, any> ? Awaited<R> : never;

/** 必須の印が1つでも立っているか */
type HasRequired<R extends Requirements> = true extends R[keyof R] ? true : false;

export type BaseOptions = {
	maxAttempts?: number;
	backoff?: Backoff;
	/** 実行開始の遅延, DO alarm管理でQueuesの12時間上限は非適用 */
	delayMs?: number;
	/** 絶対時刻での予約, delayMsとは排他 */
	runAt?: number;
	/** 絶対時刻での期限, 経過後は実行せずCANCELLED */
	expiresAt?: number;
	/** 投入時刻からの相対の期限, expiresAtとは排他 */
	expiresInMs?: number;
	timeoutMs?: number;
	priority?: number;
	guarantee?: DeliveryGuarantee;
};

type KeyOptions<R extends Requirements> = (R['concurrencyKey'] extends true ? { concurrencyKey: string } : { concurrencyKey?: string }) &
	(R['uniqueKey'] extends true ? { uniqueKey: string } : { uniqueKey?: string });

export type EnqueueOptions<R extends Requirements = {}> = BaseOptions & KeyOptions<R>;

/** 必須の印があればoptionsを必須引数化 */
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
 * enqueueManyは実測を受けて必須化, 個別RPCの逐次enqueueは78件/秒でDOの1,000 req/sソフト上限が律速
 */
export interface JobQueue<M extends Performers> {
	enqueue(...args: { [K in keyof M]: EnqueueArgs<M, K> }[keyof M]): Promise<string>;
	enqueueMany(items: readonly EnqueueItem<M>[]): Promise<string[]>;
}

/**
 * `performers`から`Performers`を導く(ADR-0010)
 * ctorはインスタンス型を, `remote()`の印は同梱した相手のperformer型を抽出
 * これで`config.performers`1箇所からbindingごとのpayloadと必須キーが確定
 */
export type PerformersOf<R extends Record<string, unknown>> = {
	[K in keyof R]: R[K] extends RemoteRef<infer P>
		? P
		: R[K] extends new (ctx: any, env: any) => infer I
			? I extends PerformerLike<any, any, any>
				? I
				: never
			: never;
};

/** unionをintersectionへ変換, 分配した関数引数の反変性を利用 */
type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;

/**
 * `performers`のctorが受け取るEnv, `defineTsumugi`が明示の型引数なしでEnvを推論するのに使う(#5)
 * 全performerは同一のWorker環境で初期化, 各envのintersectionを採用
 * unionだと1つのperformerのbindingしか満たさない環境も検査を通過
 * `WorkerEntrypoint`のctorは第2引数がEnv
 */
export type EnvOf<R extends Record<string, unknown>> = UnionToIntersection<
	{ [K in keyof R]: R[K] extends new (ctx: any, env: infer E) => any ? E : never }[keyof R]
>;

/** enqueueの追加フィールド,`EnqueueOptions`に無くDOへ渡すもの */
type ExtraInputFields = {
	/** uniqueKeyの予約を保持する期間, 経過後は同じキーでも新規ジョブ */
	uniqueForMs?: number;
	/** 分割している場合の投入先の決定に使う(ADR-0011) */
	partitionKey?: string;
};

/**
 * オブジェクト形の型付きenqueue入力(ADR-0010)
 * bindingで判別し、payloadと必須キーをperformerの宣言から強制
 * 構造は`EnqueueInput`の部分集合, ランタイムはそのままDOへ転送可能
 */
export type TypedEnqueueInput<M extends Performers, K extends keyof M = keyof M> = {
	[Key in K]: { binding: Key; payload: PayloadOf<M[Key]> } & EnqueueOptions<ReqOf<M[Key]>> & ExtraInputFields;
}[K];
