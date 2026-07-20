// tsconfig.core.json専用, src/の外に置き通常のビルドからは読ませない
// coreがworkerdの型を読まないことで, workerd固有APIへの非依存を機械的に保証する(ADR-0018)
// Web標準として全ランタイムに存在する型だけを最小限補う
// workerd固有の型(DurableObjectState, D1Database等)は追加禁止

interface AbortSignal {
	readonly aborted: boolean;
	readonly reason: unknown;
	throwIfAborted(): void;
	addEventListener(type: 'abort', listener: () => void): void;
	removeEventListener(type: 'abort', listener: () => void): void;
}
