// tsconfig.core.json専用, 通常ビルドの対象外
// workerd型を除外しcoreのworkerd非依存を保証(ADR-0018)
// NOTE: workerd固有の型(DurableObjectState, D1Database等)は追加禁止

interface AbortSignal {
	readonly aborted: boolean;
	readonly reason: unknown;
	throwIfAborted(): void;
	addEventListener(type: 'abort', listener: () => void): void;
	removeEventListener(type: 'abort', listener: () => void): void;
}
